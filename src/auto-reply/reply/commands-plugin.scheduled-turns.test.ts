import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { listSwarmRunReservationIds } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
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
  type Fixture,
  pluginId,
  scheduleRequest,
  withCommandPlugin,
} from "./commands-plugin.scheduled-turns.test-support.js";

const schedules = (ctx: PluginCommandContext) =>
  expectDefined(ctx.runtimeContext?.scheduledTurns, "schedule capability");
const nativeRuntime = (ctx: PluginCommandContext) =>
  expectDefined(ctx.runtimeContext?.subagents, "native child runtime");
function expectResult(fixture: Fixture, fields: object) {
  expect(fixture.scheduledResults[0]).toMatchObject(fields);
}
const waitForChild = (runId: string) =>
  vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.status).toBe("terminal"), {
    timeout: 15_000,
  });
function installVeto(fixture: Fixture, handler: Parameters<typeof addTestHook>[0]["handler"]) {
  addTestHook({ registry: fixture.registry, pluginId, hookName: "before_tool_call", handler });
  initializeGlobalHookRunner(fixture.registry);
}

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
        const scheduling = schedules(ctx);
        retained = scheduling;
        const definition = scheduleRequest();
        const [first, duplicate] = await Promise.all([
          scheduling.schedule(definition),
          scheduling.schedule(definition),
        ]).catch((error: unknown) => {
          schedulingError = error;
          throw error;
        });
        expect(duplicate).toEqual(first);
        accepted = first;
        await expect(scheduling.schedule({ ...definition, maxRuns: 3 })).rejects.toThrow(
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
        const native = schedules(ctx);
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
  it("lets a refused request retry and bounds continuations per invocation", async () => {
    await withCommandPlugin(async (fixture) => {
      let denials = 1;
      installVeto(fixture, async (event: { toolName: string }) =>
        event.toolName === "automations" && denials-- > 0
          ? { block: true, blockReason: "transient denial" }
          : undefined,
      );
      fixture.handler.mockImplementation(async (ctx) => {
        const scheduling = schedules(ctx);
        const request = scheduleRequest();
        await expect(scheduling.schedule(request)).rejects.toThrow(/not accepted|denied|blocked/i);
        expect(await fixture.readJobs()).toEqual([]);
        // The failed request is not pinned to its rejection; the retry reaches the scheduler.
        const retried = await scheduling.schedule(request);
        expect(await scheduling.schedule(request)).toEqual(retried);
        for (const requestId of ["second", "third", "fourth"]) {
          await scheduling.schedule({ ...request, requestId });
        }
        await expect(scheduling.schedule({ ...request, requestId: "fifth" })).rejects.toThrow(
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
  it("accepts a native child from a scheduled occurrence under the original lineage", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      fixture.installAgentTurnFacade();
      const id = await createContinuation(fixture);
      // Hold swarm capacity so the accepted child stays queued and never reaches a model.
      const capacity = holdScheduledChildCapacity(fixture);
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      fixture.handler.mockImplementation(async (ctx) => {
        const native = nativeRuntime(ctx);
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
      expectResult(fixture, { status: "ok", outputText: "child accepted" });
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
      const runId = expectDefined(childRunId, "accepted child run");
      await waitForChild(runId);
      // Admission survives occurrence settlement; the fixture has no published reply runtime.
      expect(subagentRuns.get(runId)?.execution.outcome).toMatchObject({
        status: "error",
        error: "published reply runtime missing for main",
      });
    });
  });
  it("fails a queued scheduled child on demotion without waiting for capacity", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      fixture.installAgentTurnFacade();
      const id = await createContinuation(fixture);
      const capacity = holdScheduledChildCapacity(fixture);
      let childRunId: string | undefined;
      fixture.handler.mockImplementation(async (ctx) => {
        const child = await nativeRuntime(ctx).spawn({
          requestId: "scheduled-queued",
          task: "Synthetic scheduled child released after its occurrence settles",
          context: "isolated",
        });
        childRunId = child.runId;
        return { text: "child queued" };
      });
      try {
        await fixture.cron.run(id, "force");
        expectResult(fixture, { status: "ok", outputText: "child queued" });
        const runId = expectDefined(childRunId, "queued child run");
        expect(subagentRuns.get(runId)?.execution).toMatchObject({ status: "queued" });
        capacity.expectWaiting(runId);
        fixture.demoteOwner();
        // Revocation, not a freed slot, settles the waiting child.
        await waitForChild(runId);
        expect(listSwarmRunReservationIds()).not.toContain(runId);
        expect(subagentRuns.get(runId)?.execution.outcome).toMatchObject({
          status: "error",
          error: "Queued channel operator authority changed; submit a new request.",
        });
      } finally {
        capacity.release();
      }
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
        expectResult(fixture, {
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
      expectResult(fixture, {
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
      expectResult(fixture, {
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
        expectResult(fixture, {
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
        expectResult(fixture, { status: "error", executionStarted: true });
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
        expectResult(fixture, { status: "error", executionStarted: false });
        expect(fixture.handler).not.toHaveBeenCalled();
        expect(await fixture.userInputs()).toEqual(before);
      });
    },
  );
});
