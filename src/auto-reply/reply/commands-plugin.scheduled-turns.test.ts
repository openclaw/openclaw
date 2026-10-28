import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { listSwarmRunReservationIds } from "../../agents/subagents/swarm/swarm-scheduler.js";
import {
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { requestActiveCronJobCancellation } from "../../cron/active-jobs.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import type { PluginCommandScheduledTurns } from "../../plugins/runtime/types-scheduled-turns.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { holdScheduledChildCapacity } from "./commands-plugin.scheduled-capacity.test-support.js";
import {
  commandInvocation,
  createContinuation,
  declaredCommand,
  pluginId,
  scheduleRequest,
  withCommandPlugin,
  type Fixture,
} from "./commands-plugin.scheduled-turns.test-support.js";

// Every test doubles as a no-fallback guard: no scheduled occurrence may reach an ordinary
// session prompt or the embedded model runner. Model choice is stubbed only for the child
// lineage case, whose isolated state has no provider catalog; it is not the behavior under test.
const guards = vi.hoisted(() => ({ embeddedRuns: 0, stubModelChoice: false }));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: async () => {
    guards.embeddedRuns += 1;
    throw new Error("scheduled command test must not run the embedded model runner");
  },
}));
vi.mock("../../agents/model-runtime-choice.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-runtime-choice.js")>();
  return {
    ...actual,
    prepareModelChoice: async (params: Parameters<typeof actual.prepareModelChoice>[0]) =>
      guards.stubModelChoice
        ? { kind: "automatic" as const, ref: { provider: "openai", model: "gpt-4.1" } }
        : await actual.prepareModelChoice(params),
  };
});

afterEach(() => {
  expect(guards.embeddedRuns, "no embedded model run").toBe(0);
  guards.embeddedRuns = 0;
  guards.stubModelChoice = false;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});
describe("requester-admitted scheduled commands", () => {
  it.each([
    ["missing scheduled contract", { scheduledContract: false }],
    ["missing manifest capability", { manifestCapabilities: ["subagents"] }],
    ["public scheduling command", { commands: [{ ...declaredCommand, requireAuth: false }] }],
    ["implicit command auth", { commands: [{ ...declaredCommand, requireAuth: undefined }] }],
    [
      "missing native subagents",
      { commands: [{ ...declaredCommand, runtimeCapabilities: ["scheduledTurns"] }] },
    ],
  ] satisfies Array<[string, NonNullable<Parameters<typeof withCommandPlugin>[1]>]>)(
    "refuses %s at the real loader boundary",
    async (_label, options) => {
      await withCommandPlugin(async (fixture) => {
        expect(
          fixture.registry.commands.filter((item) => item.command.name === "review-panel"),
        ).toEqual([]);
        expect(
          fixture.registry.diagnostics.some(
            (item) => item.pluginId === pluginId && item.level === "error",
          ),
        ).toBe(true);
        await commandInvocation(fixture).run();
        expect(fixture.handler).not.toHaveBeenCalled();
        expect(await fixture.readJobs()).toEqual([]);
      }, options);
    },
  );
  it("creates one native job with the exact private parent and joins identical calls", async () => {
    await withCommandPlugin(async (fixture) => {
      let retained: PluginCommandScheduledTurns | undefined;
      let accepted: { jobId: string } | undefined;
      let schedulingError: unknown;
      fixture.handler.mockImplementation(async (ctx) => {
        // Scheduling stays outside the native helpers, which keep their optional list.
        const native = expectDefined(ctx.runtimeContext?.subagents, "native helpers");
        expect(Object.keys(native).toSorted()).toEqual(["collect", "list", "spawn"]);
        await expect(expectDefined(native.list, "native child list")()).resolves.toEqual([]);
        const schedules = expectDefined(
          ctx.runtimeContext?.scheduledTurns,
          "live schedule capability",
        );
        retained = schedules;
        const definition = scheduleRequest();
        const [first, duplicate] = await Promise.all([
          schedules.schedule(definition),
          schedules.schedule(definition),
        ]).catch((error: unknown) => {
          schedulingError = error;
          throw error;
        });
        expect(duplicate).toEqual(first);
        accepted = first;
        await expect(schedules.schedule({ ...definition, maxRuns: 3 })).rejects.toThrow(
          /different input/,
        );
        return { text: "scheduled" };
      });
      const dispatched = await commandInvocation(fixture).run();
      expect(schedulingError).toBeUndefined();
      expect(dispatched?.reply?.text).toBe("scheduled");
      const jobs = await fixture.readJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: accepted?.jobId,
        delivery: { mode: "none" },
        state: { pluginCommandRuns: 0 },
        pluginCommand: {
          pluginId,
          command: "review-panel",
          maxRuns: 2,
          parent: { sessionId: "command-parent", lifecycleRevision: "revision-1" },
        },
      });
      await expect(
        expectDefined(retained, "retained capability").schedule(scheduleRequest()),
      ).rejects.toThrow(/closed|active|ended|abort/i);
      expect(await fixture.readJobs()).toHaveLength(1);
    });
  });
  it("persists the validated snapshot when the caller mutates a pending request", async () => {
    await withCommandPlugin(async (fixture) => {
      const original = { ...scheduleRequest(), args: "original arguments" };
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.scheduledTurns, "schedule capability");
        const input = { ...original, schedule: { ...original.schedule } };
        const pending = native.schedule(input);
        input.requestId = "mutated-id";
        input.command = "ordinary";
        input.args = "mutated arguments";
        input.deadlineAtMs = original.deadlineAtMs + 30 * 86_400_000;
        input.maxRuns = 99;
        input.schedule.everyMs = 1_000;
        const accepted = await pending;
        expect(accepted).toMatchObject({
          deadlineAtMs: original.deadlineAtMs,
          maxRuns: original.maxRuns,
        });
        expect(await native.schedule(original)).toEqual(accepted);
        return { text: "snapshot retained" };
      });
      expect((await commandInvocation(fixture).run())?.reply?.text).toBe("snapshot retained");
      const jobs = await fixture.readJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        schedule: original.schedule,
        pluginCommand: {
          command: original.command,
          args: original.args,
          deadlineAtMs: original.deadlineAtMs,
          maxRuns: original.maxRuns,
        },
      });
    });
  });
  it("does not expose schedules to ordinary commands", async () => {
    await withCommandPlugin(async (fixture) => {
      fixture.handler.mockImplementation((ctx) => ({
        text: String(ctx.runtimeContext?.scheduledTurns !== undefined),
      }));
      expect((await commandInvocation(fixture, "/ordinary").run())?.reply?.text).toBe("false");
      expect(await fixture.readJobs()).toEqual([]);
    });
  });
  it("honors native before-tool denial without creating a fallback job", async () => {
    await withCommandPlugin(async (fixture) => {
      addTestHook({
        registry: fixture.registry,
        pluginId,
        hookName: "before_tool_call",
        handler: async (event: { toolName: string }) =>
          event.toolName === "automations"
            ? { block: true, blockReason: "schedule denied" }
            : undefined,
      });
      initializeGlobalHookRunner(fixture.registry);
      fixture.handler.mockImplementation(async (ctx) => {
        await expect(
          expectDefined(ctx.runtimeContext?.scheduledTurns, "schedule capability").schedule(
            scheduleRequest(),
          ),
        ).rejects.toThrow(/denied|not accepted|blocked/i);
        return { text: "refused" };
      });
      expect((await commandInvocation(fixture).run())?.reply?.text).toBe("refused");
      expect(await fixture.readJobs()).toEqual([]);
    });
  });
  it("lets a refused request retry and bounds continuations per invocation", async () => {
    await withCommandPlugin(async (fixture) => {
      let denials = 1;
      addTestHook({
        registry: fixture.registry,
        pluginId,
        hookName: "before_tool_call",
        handler: async (event: { toolName: string }) =>
          event.toolName === "automations" && denials-- > 0
            ? { block: true, blockReason: "transient denial" }
            : undefined,
      });
      initializeGlobalHookRunner(fixture.registry);
      fixture.handler.mockImplementation(async (ctx) => {
        const schedules = expectDefined(ctx.runtimeContext?.scheduledTurns, "schedule capability");
        const request = scheduleRequest();
        await expect(schedules.schedule(request)).rejects.toThrow(/not accepted|denied|blocked/i);
        // The failed request is not pinned to its rejection; the retry reaches the scheduler.
        const retried = await schedules.schedule(request);
        expect(await schedules.schedule(request)).toEqual(retried);
        for (const requestId of ["second", "third", "fourth"]) {
          await schedules.schedule({ ...request, requestId });
        }
        await expect(schedules.schedule({ ...request, requestId: "fifth" })).rejects.toThrow(
          /at most 4 continuations/,
        );
        return { text: "bounded" };
      });
      expect((await commandInvocation(fixture).run())?.reply?.text).toBe("bounded");
      expect(await fixture.readJobs()).toHaveLength(4);
    });
  });
});

describe("native scheduled command execution", () => {
  it("runs the final allowed attempt, then retires the schedule instead of rearming it", async () => {
    await withCommandPlugin(async (fixture) => {
      let accepted: { jobId: string } | undefined;
      fixture.handler.mockImplementation(async (ctx) => {
        accepted = await expectDefined(
          ctx.runtimeContext?.scheduledTurns,
          "schedule capability",
        ).schedule(scheduleRequest({ maxRuns: 1 }));
        return { text: "scheduled" };
      });
      await commandInvocation(fixture).run();
      const id = expectDefined(accepted, "durable native schedule").jobId;
      fixture.handler.mockImplementation(() => ({ text: "final occurrence" }));
      await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ok: true, ran: true });
      expect(fixture.scheduledResults).toMatchObject([
        { status: "ok", outputText: "final occurrence" },
      ]);
      const [retired] = await fixture.readJobs();
      expect(retired).toMatchObject({ enabled: false, state: { pluginCommandRuns: 1 } });
      expect(retired?.state.nextRunAtMs).toBeUndefined();
      await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ran: false });
      expect(fixture.scheduledResults).toHaveLength(1);
    });
  });
  it("accepts a native child from a scheduled occurrence under the original lineage", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      // Hold swarm capacity so the accepted child stays queued and never reaches a model.
      const capacity = holdScheduledChildCapacity(fixture);
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "scheduled native runtime");
        const child = await native.spawn({
          requestId: "scheduled-positive",
          task: "Synthetic scheduled child; capacity keeps it queued",
          context: "isolated",
        });
        childRunId = child.runId;
        childSessionKey = child.childSessionKey;
        expect(await native.collect({ ids: [child.runId], timeoutSeconds: 0 })).toMatchObject({
          pending: [child.runId],
        });
        return { text: "child accepted" };
      });
      try {
        await fixture.cron.run(id, "force");
        capacity.expectWaiting(expectDefined(childRunId, "accepted child run"));
      } finally {
        capacity.release();
      }
      expect(fixture.scheduledResults[0]).toMatchObject({
        status: "ok",
        outputText: "child accepted",
      });
      const parent = fixture.params();
      const child = loadSessionEntry({
        agentId: "main",
        sessionKey: expectDefined(childSessionKey, "accepted child session"),
        storePath: parent.storePath,
      });
      expect(child?.spawnedBy).toBe(parent.sessionKey);
      // The child inherits the stored ceiling minus scheduling: no recursive schedules.
      expect(child?.inheritedToolAllow).toEqual(["read", "sessions_spawn", "agents_wait"]);
      expect(subagentRuns.get(expectDefined(childRunId, "accepted child run"))).toMatchObject({
        requesterSessionKey: parent.sessionKey,
        requesterTurnRunId: expectDefined(capacity.occurrenceRunId(), "scheduled occurrence run"),
      });
    });
  });
  /**
   * Queues one native child from a scheduled occurrence. A published revocation settles the
   * child while its lane is still full; otherwise it is released and meets its launch check.
   */
  async function releaseQueuedScheduledChild(
    change: "none" | "demotion" | "identity removal" | "unannounced narrowing",
  ) {
    guards.stubModelChoice = true;
    let outcome: unknown;
    await withCommandPlugin(async (fixture) => {
      fixture.installAgentTurnFacade();
      const id = await createContinuation(fixture);
      // Hold swarm capacity so the child is still queued when its occurrence settles.
      const capacity = holdScheduledChildCapacity(fixture);
      let childRunId: string | undefined;
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "scheduled native runtime");
        const child = await native.spawn({
          requestId: "scheduled-queued",
          task: "Synthetic scheduled child released after its occurrence settles",
          context: "isolated",
        });
        childRunId = child.runId;
        return { text: "child queued" };
      });
      const terminal = (runId: string) =>
        vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.status).toBe("terminal"), {
          timeout: 15_000,
        });
      try {
        await fixture.cron.run(id, "force");
        expect(fixture.scheduledResults[0]).toMatchObject({
          status: "ok",
          outputText: "child queued",
        });
        const runId = expectDefined(childRunId, "queued child run");
        expect(subagentRuns.get(runId)?.execution).toMatchObject({ status: "queued" });
        capacity.expectWaiting(runId);
        if (change === "demotion") {
          fixture.demoteOwner();
        } else if (change === "identity removal") {
          fixture.removeOwner();
        } else if (change === "unannounced narrowing") {
          // A committed role change that no policy notification announced.
          const admin = expectDefined(fixture.cfg.gateway?.roles?.definitions.admin, "admin role");
          admin.scopes = ["operator.read"];
          await delay(50);
          capacity.expectWaiting(runId);
        }
        if (change === "demotion" || change === "identity removal") {
          // The revocation, not a freed slot, settles the waiting child.
          await terminal(runId);
          expect(listSwarmRunReservationIds()).not.toContain(runId);
        }
      } finally {
        capacity.release();
      }
      const runId = expectDefined(childRunId, "queued child run");
      await terminal(runId);
      outcome = subagentRuns.get(runId)?.execution.outcome;
    });
    return outcome;
  }
  it("admits a queued scheduled child's agent turn while its requester stays authorized", async () => {
    // After its occurrence settled, the child passed the real agent turn's admission
    // revalidation. This harness publishes no reply runtime, so the turn stops at that next
    // seam, still before the model runner (the fixture's no-embedded-run guard).
    await expect(releaseQueuedScheduledChild("none")).resolves.toMatchObject({
      status: "error",
      error: "published reply runtime missing for main",
    });
  });
  it.each(["demotion", "identity removal"] as const)(
    "fails a queued scheduled child on its requester's %s without waiting for capacity",
    async (change) => {
      await expect(releaseQueuedScheduledChild(change)).resolves.toMatchObject({
        status: "error",
        error: "Queued channel operator authority changed; submit a new request.",
      });
    },
  );
  it("refuses a queued scheduled child at launch after an unannounced role change", async () => {
    await expect(releaseQueuedScheduledChild("unannounced narrowing")).resolves.toMatchObject({
      status: "error",
      error: "Queued channel operator authority changed; submit a new request.",
    });
  });
  it("ends a running scheduled occurrence when its channel requester is demoted", async () => {
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      fixture.handler.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { text: "late occurrence output" };
      });
      const before = await fixture.assistantOutputs();
      let settled = false;
      const run = fixture.cron.run(id, "force").finally(() => {
        settled = true;
      });
      try {
        await entered.promise;
        fixture.demoteOwner();
        // The occurrence settles while its handler is still awaiting, not when it returns.
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10_000 });
        expect(fixture.scheduledResults[0]).toMatchObject({
          status: "error",
          error: expect.stringContaining("Queued channel operator authority changed"),
          errorClassification: { kind: "aborted" },
          delivered: false,
        });
      } finally {
        release.resolve();
        await run;
      }
      expect(await fixture.assistantOutputs()).toEqual(before);
    });
  });
  it("refuses a same-metadata plugin reload before command or input acceptance", async () => {
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      const before = await fixture.userInputs();
      await fixture.reloadPlugin();
      fixture.handler.mockClear();
      await fixture.cron.run(id, "force");
      expect(fixture.scheduledResults[0]).toMatchObject({
        status: "error",
        error: expect.stringContaining("original plugin instance was replaced"),
        errorClassification: { kind: "permanent" },
        executionStarted: false,
      });
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(await fixture.userInputs()).toEqual(before);
      expect(await fixture.assistantOutputs()).toEqual([]);
      // The first refusal retires it; it never errors on toward generic auto-disable.
      const [retired] = await fixture.readJobs();
      expect(retired).toMatchObject({ enabled: false });
      expect(retired?.state.nextRunAtMs).toBeUndefined();
      expect(retired?.state.autoDisabled).toBeUndefined();
      await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ran: false });
      expect(fixture.scheduledResults).toHaveLength(1);
    });
  });
  it("routes scheduled child requests through the real native tool veto", async () => {
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      const seen: string[] = [];
      const acceptedBefore = [...subagentRuns.keys()];
      addTestHook({
        registry: fixture.registry,
        pluginId,
        hookName: "before_tool_call",
        handler: async (event: { toolName: string }) => {
          seen.push(event.toolName);
          return event.toolName === "sessions_spawn"
            ? { block: true, blockReason: "scheduled child denied" }
            : undefined;
        },
      });
      initializeGlobalHookRunner(fixture.registry);
      fixture.handler.mockImplementation(async (ctx) => {
        await expect(
          expectDefined(ctx.runtimeContext?.subagents, "native child runtime").spawn({
            requestId: "scheduled-veto",
            task: "Never execute: native hook veto",
          }),
        ).rejects.toThrow("Native subagent spawn was not accepted.");
        return { text: "native child policy enforced" };
      });
      await fixture.cron.run(id, "force");
      expect(fixture.scheduledResults[0]?.error).toBeUndefined();
      expect(fixture.scheduledResults[0]).toMatchObject({
        status: "ok",
        outputText: "native child policy enforced",
      });
      expect(seen).toEqual(["sessions_spawn"]);
      expect([...subagentRuns.keys()]).toEqual(acceptedBefore);
      const parent = fixture.params();
      expect(
        await listSessionChildEntriesReadOnly({
          agentId: "main",
          sessionKey: parent.sessionKey,
          storePath: parent.storePath,
        }),
      ).toEqual([]);
      expect((await fixture.readJobs())[0]?.state.pluginCommandRuns).toBe(1);
    });
  });
  it("restores the real requester and commits command output only to the exact parent", async () => {
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      fixture.handler.mockImplementation(async (ctx) => {
        expect(ctx.runtimeContext?.subagents).toBeDefined();
        expect(ctx.runtimeContext?.scheduledTurns).toBeUndefined();
        await expect(
          expectDefined(ctx.runtimeContext?.llm, "strict model runtime").complete({
            messages: [{ role: "user", content: "must never dispatch" }],
          }),
        ).rejects.toThrow(/admitted native subagent/);
        return { text: "continued in original parent" };
      });
      await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ok: true, ran: true });
      expect(fixture.scheduledResults).toHaveLength(1);
      expect(fixture.scheduledResults[0]).toMatchObject({
        status: "ok",
        executionStarted: true,
        sessionId: "command-parent",
        delivered: false,
        deliveryAttempted: false,
        outputText: "continued in original parent",
      });
      expect(fixture.handler).toHaveBeenCalledTimes(2);
      expect((await fixture.readJobs())[0]?.state.pluginCommandRuns).toBe(1);
      expect(await fixture.userInputs()).toHaveLength(2);
      expect(await fixture.assistantOutputs()).toEqual([
        [{ type: "text", text: "continued in original parent" }],
      ]);
    });
  });
  it.each(["stop", "cancel", "reset", "restricted tools"] as const)(
    "refuses late effects after %s while a command is pending",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const id = await createContinuation(fixture);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const settled = createDeferredCore();
        let retained: PluginCommandContext["runtimeContext"];
        fixture.handler.mockImplementation(async (ctx) => {
          retained = ctx.runtimeContext;
          entered.resolve();
          try {
            await release.promise;
            return { text: "must not appear after invalidation" };
          } finally {
            settled.resolve();
          }
        });
        const running = fixture.cron.run(id, "force");
        try {
          await entered.promise;
          if (change === "stop") {
            fixture.cron.stop();
          } else if (change === "cancel") {
            requestActiveCronJobCancellation(id, "Requester stopped command");
          } else if (change === "reset") {
            await fixture.resetParent();
          } else {
            await fixture.restrictParentTools();
          }
        } finally {
          release.resolve();
        }
        await running;
        await settled.promise;
        expect(fixture.scheduledResults[0]).toMatchObject({
          status: "error",
          executionStarted: true,
          delivered: false,
          deliveryAttempted: false,
          ...(change === "cancel" ? { errorClassification: { kind: "aborted" } } : {}),
        });
        expect(await fixture.assistantOutputs()).toEqual([]);
        expect((await fixture.readJobs())[0]?.state.pluginCommandRuns).toBe(1);
        await expect(
          expectDefined(retained?.subagents, "invocation runtime").collect({ ids: [] }),
        ).rejects.toThrow(
          change === "cancel"
            ? /Requester stopped command/
            : /closed|active|ended|abort|current|changed|reset/i,
        );
      });
    },
  );
  it.each(["thrown failure", "agent continuation"] as const)(
    "does not turn %s into successful chat or ambient agent execution",
    async (failure) => {
      await withCommandPlugin(async (fixture) => {
        const id = await createContinuation(fixture);
        fixture.handler.mockImplementation(() => {
          if (failure === "thrown failure") {
            throw new Error("synthetic handler failure");
          }
          return { text: "must not commit", continueAgent: true };
        });
        await fixture.cron.run(id, "force");
        expect(fixture.scheduledResults[0]).toMatchObject({
          status: "error",
          executionStarted: true,
        });
        expect(fixture.scheduledResults[0]?.error).toMatch(
          failure === "thrown failure" ? /synthetic handler failure/ : /cannot continue/,
        );
        expect(await fixture.assistantOutputs()).toEqual([]);
      });
    },
  );
  it.each(["reset", "revoked operator"] as const)(
    "refuses a %s before command or input acceptance",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const id = await createContinuation(fixture);
        const before = await fixture.userInputs();
        if (change === "reset") {
          await fixture.resetParent();
        } else {
          fixture.revokeOwner();
        }
        fixture.handler.mockClear();
        await fixture.cron.run(id, "force");
        expect(fixture.scheduledResults[0]).toMatchObject({
          status: "error",
          executionStarted: false,
        });
        expect(fixture.handler).not.toHaveBeenCalled();
        expect(await fixture.userInputs()).toEqual(before);
      });
    },
  );
});

// An occurrence has no sender: tool policy resolves as for capped scheduled runs, from the
// requester's recorded account. The fixture requester is Discord sender 100 on account `team`
// in channel `maintainers`; its stored ceiling is read plus native scheduling.
describe("scheduled command tool policy", () => {
  /** Runs one forced occurrence that spawns a child held queued by swarm capacity. */
  async function runOccurrence(fixture: Fixture, id: string) {
    const results = fixture.scheduledResults.length;
    const inputs = (await fixture.userInputs()).length;
    let childSessionKey: string | undefined;
    fixture.handler.mockClear();
    fixture.handler.mockImplementation(async (ctx) => {
      const native = expectDefined(ctx.runtimeContext?.subagents, "scheduled native runtime");
      const child = await native.spawn({
        requestId: `policy-${results}`,
        task: "Synthetic scheduled child; capacity keeps it queued",
        context: "isolated",
      });
      childSessionKey = child.childSessionKey;
      return { text: "child accepted" };
    });
    const capacity = holdScheduledChildCapacity(fixture);
    try {
      await fixture.cron.run(id, "force");
    } finally {
      capacity.release();
    }
    const child =
      childSessionKey === undefined
        ? undefined
        : loadSessionEntry({
            agentId: "main",
            sessionKey: childSessionKey,
            storePath: fixture.params().storePath,
          });
    const childDeny = child?.inheritedToolDeny ?? [];
    return {
      result: fixture.scheduledResults[results],
      handlerCalls: fixture.handler.mock.calls.length,
      newInputs: (await fixture.userInputs()).length - inputs,
      childTools: child?.inheritedToolAllow?.filter((tool) => !childDeny.includes(tool)),
    };
  }

  it("does not apply the wildcard sender entry to an occurrence", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      // The requester's own entry allows its tools; the wildcard is meant for other senders.
      fixture.cfg.tools = {
        ...fixture.cfg.tools,
        toolsBySender: { "channel:discord:100": {}, "*": { deny: ["read"] } },
      };
      const occurrence = await runOccurrence(fixture, await createContinuation(fixture));
      expect(occurrence.result).toMatchObject({ status: "ok", outputText: "child accepted" });
      expect(occurrence.childTools).toEqual(["read", "sessions_spawn", "agents_wait"]);
    });
  });

  it("revalidates the requester's account on every occurrence", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      const discord = expectDefined(fixture.cfg.channels?.discord, "discord channel config");
      // A scheduled run has no guild id, so Discord resolves it through the "*" guild.
      expectDefined(discord.accounts?.team, "requester account").guilds = {
        "*": { channels: { maintainers: { tools: { deny: ["read"] } } } },
      };
      const restricted = await runOccurrence(fixture, id);
      expect(restricted.result).toMatchObject({ status: "ok", outputText: "child accepted" });
      expect(restricted.childTools).toEqual(["sessions_spawn", "agents_wait"]);

      discord.accounts = { other: { allowFrom: ["*"] } };
      const removed = await runOccurrence(fixture, id);
      expect(removed.result).toMatchObject({
        status: "error",
        executionStarted: false,
        error: expect.stringContaining('Scheduled account "team" is unavailable'),
      });
      expect(removed.handlerCalls).toBe(0);
      expect(removed.newInputs).toBe(0);
    });
  });

  it("keeps running a direct-chat requester's occurrence on its named account", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(
      async (fixture) => {
        const occurrence = await runOccurrence(fixture, await createContinuation(fixture));
        expect(occurrence.result).toMatchObject({ status: "ok", outputText: "child accepted" });
        expect(occurrence.childTools).toEqual(["read", "sessions_spawn", "agents_wait"]);
      },
      // A direct-chat parent key has no channel segment; the schedule's channel stands in.
      { sessionKey: "agent:main:direct:100" },
    );
  });
});
