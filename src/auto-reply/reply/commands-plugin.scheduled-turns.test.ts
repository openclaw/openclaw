import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import {
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requestActiveCronJobCancellation } from "../../cron/active-jobs.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronAgentExecutionStarted } from "../../cron/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { invalidateOperatorRolePolicy } from "../../gateway/operator-role-policy.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayCronAgentJobRunner } from "../../gateway/server-cron-agent-run.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginCommandScheduledTurns } from "../../plugins/runtime/types-scheduled-turns.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { runWithCommandNativeSubagents } from "./dispatch-native-subagent.js";
import { finalizeInboundContext } from "./inbound-context.js";
const pluginId = "command-controller";

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

type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type CommandMetadata = {
  name: string;
  requireAuth?: boolean;
  runtimeCapabilities?: unknown;
  channels?: string[];
};
const declaredCommand: CommandMetadata = {
  name: "review-panel",
  requireAuth: true,
  runtimeCapabilities: ["subagents", "scheduledTurns"],
};

type Fixture = {
  cfg: OpenClawConfig;
  registry: PluginRegistry;
  params: (body?: string) => HandleCommandsParams;
  handler: ReturnType<typeof vi.fn<Handler>>;
  userInputs: () => Promise<unknown[]>;
  assistantOutputs: () => Promise<unknown[]>;
  restrictParentTools: () => Promise<unknown>;
  revokeOwner: () => void;
  /** Commits a role downgrade and publishes it, as the `users.setRole` Gateway method does. */
  demoteOwner: () => void;
  /** Lets a launched child reach its agent turn through the real Gateway instance runtime. */
  installAgentTurnFacade: () => void;
  readJobs: () => Promise<import("../../cron/types.js").CronStoredJob[]>;
  cron: CronService;
  scheduledResults: Array<Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>>;
  resetParent: () => Promise<unknown>;
  reloadPlugin: () => Promise<void>;
  onExecutionStarted?: (info: CronAgentExecutionStarted) => void;
};

// The fixture is a third-party plugin loaded from disk, not an injected registry record.
// Only its application handler crosses this bridge; registration, selection, authority,
// native tool policy, and command lifetime all use their production owners.
async function withCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    commands?: CommandMetadata[];
    manifestCapabilities?: unknown;
    scheduledContract?: boolean;
  } = {},
) {
  await withAdminIngress(async ({ cfg, state, admins, context, gateway }) => {
    const bridge = Symbol.for(`openclaw.command-native-test.${randomUUID()}`);
    const handler = vi.fn<Handler>((ctx) => ({
      text: JSON.stringify({
        subagents: ctx.runtimeContext?.subagents !== undefined,
        args: ctx.args,
      }),
    }));
    Reflect.set(globalThis, bridge, handler);
    const pluginDir = state.path("controller-plugin");
    await fs.mkdir(pluginDir);
    const pluginFile = path.join(pluginDir, "index.cjs");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: {
          ...(options.scheduledContract === false
            ? {}
            : { sessionScheduledTurns: ["requester-command"] }),
          commandRuntimeCapabilities:
            options.manifestCapabilities === undefined
              ? ["subagents", "scheduledTurns"]
              : options.manifestCapabilities,
        },
      }),
    );
    const commands = options.commands ?? [declaredCommand, { name: "ordinary" }];
    await fs.writeFile(
      pluginFile,
      `module.exports = { id: ` +
        JSON.stringify(pluginId) +
        `, register(api) {
        for (const command of ` +
        JSON.stringify(commands) +
        `) {
          api.registerCommand({ ...command, description: "Synthetic review command", acceptsArgs: true,
            handler(ctx) { return globalThis[Symbol.for(` +
        JSON.stringify(Symbol.keyFor(bridge)) +
        `)](ctx); }
          });
        }
      } };`,
    );
    cfg.agents = { defaults: { workspace: state.workspaceDir, model: "openai/gpt-4.1" } };
    cfg.auth = {
      profiles: { "openai:schedule-fixture": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:schedule-fixture"] },
    };
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: "openai:schedule-fixture",
          credential: { type: "api_key", provider: "openai", key: "synthetic-s6-never-sent" },
        },
      ],
    });
    cfg.commands = { ...cfg.commands, text: true };
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    cfg.session = { ...cfg.session, store: storePath };
    cfg.plugins = {
      allow: [pluginId],
      load: { paths: [pluginFile] },
      entries: { [pluginId]: { enabled: true } },
    };
    const cronStorePath = state.path("cron/jobs.json");
    let registry: PluginRegistry | undefined;
    let agentTurnRuntime: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
    const scheduledResults: Fixture["scheduledResults"] = [];
    const sessionEventPrompts: string[] = [];
    let fixtureRef: Fixture | undefined;
    const runSchedulerOwned = createScheduledGatewayRunner(
      () => gateway,
      () => registry,
    );
    const runAgentJob = createGatewayCronAgentJobRunner({
      deps: {},
      resolveCronAgent: () => ({ agentId: "main", cfg }),
      resolveGatewayContext: () => gateway,
      resolvePluginRegistry: () => registry,
    });
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: Date.now,
      storePath: cronStorePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runSchedulerOwned,
      // Present, as in the Gateway, so a misrouted command schedule would be observed here.
      runSessionEvent: async ({ text }) => {
        sessionEventPrompts.push(text);
        return { status: "error", error: "ordinary session prompt" };
      },
      runIsolatedAgentJob: async (request) => {
        const result = await runAgentJob({
          ...request,
          onExecutionStarted: (info) => {
            if (info) {
              fixtureRef?.onExecutionStarted?.(info);
            }
            request.onExecutionStarted?.(info);
          },
        });
        scheduledResults.push(result);
        return result;
      },
    });
    Object.assign(
      gateway,
      createDirectChatContext({
        cron,
        cronStorePath,
        getRuntimeConfig: () => cfg,
        resolveGatewayContext: () => gateway,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
        getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
        trackExecution: trackAsyncWork,
      }),
    );
    const inbound = await context(admins[0]!.identity.senderId);
    expectDefined(getCommandOwnerAuthority(inbound)?.operatorAuthority, "real ingress authority");
    const sessionKey = expectDefined(inbound.SessionKey, "real ingress session key");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "command-parent",
        lifecycleRevision: "revision-1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-4.1",
        authProfileOverride: "openai:schedule-fixture",
        authProfileOverrideSource: "auto",
      },
    );
    await state.writeConfig(cfg);
    const params = (body = "/review-panel") => {
      const value = buildCommandTestParams(
        body,
        cfg,
        {
          ...inbound,
          Body: body,
          CommandBody: body,
          RawBody: body,
          // The fixture ingress was created with plain text; project this as the
          // authenticated command turn, as real command dispatch does.
          CommandAuthorized: true,
          CommandTurn: undefined,
        },
        { workspaceDir: state.workspaceDir },
      );
      value.sessionKey = sessionKey;
      value.storePath = storePath;
      value.sessionEntry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey, storePath }),
        "persisted command requester",
      );
      return value;
    };
    const transcriptContents = async (role: "user" | "assistant") => {
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        storePath,
        sessionId: "command-parent",
      });
      return events.flatMap((event) => {
        const record = asOptionalRecord(event);
        const message = asOptionalRecord(record?.message);
        return record?.type === "message" && message?.role === role ? [message.content] : [];
      });
    };
    try {
      registry = loadOpenClawPlugins({
        config: cfg,
        workspaceDir: state.workspaceDir,
        cache: false,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      setActivePluginRegistry(registry);
      if (
        options.commands === undefined &&
        options.manifestCapabilities === undefined &&
        options.scheduledContract !== false
      ) {
        expect(
          registry.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
          "the valid declaring plugin must load without registration refusals",
        ).toEqual([]);
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          context: gateway,
          resolveGatewayContext: () => gateway,
          pluginRegistry: registry,
          isWebchatConnect: () => false,
        },
        () =>
          run(
            (fixtureRef = {
              cfg,
              cron,
              scheduledResults,
              resetParent: () =>
                upsertSessionEntryCore(
                  { agentId: "main", sessionKey, storePath },
                  {
                    sessionId: "replacement-parent",
                    lifecycleRevision: "revision-2",
                    updatedAt: Date.now(),
                  },
                ),
              registry: expectDefined(registry, "loaded registry"),
              reloadPlugin: async () => {
                await expect(
                  disposePluginRegistryInstances(expectDefined(registry, "previous registry")),
                ).resolves.toMatchObject({ failures: [] });
                registry = loadOpenClawPlugins({
                  config: cfg,
                  workspaceDir: state.workspaceDir,
                  cache: false,
                  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
                });
                setActivePluginRegistry(registry);
              },
              params,
              handler,
              userInputs: () => transcriptContents("user"),
              assistantOutputs: () => transcriptContents("assistant"),
              restrictParentTools: () =>
                upsertSessionEntryCore(
                  { agentId: "main", sessionKey, storePath },
                  { toolOverrides: { webSearch: false }, updatedAt: Date.now() },
                ),
              readJobs: async () => (await loadCronStore(cronStorePath)).jobs,
              revokeOwner: () => setUserProfileRole(admins[0]!.profile.id, "member"),
              demoteOwner: () => {
                setUserProfileRole(admins[0]!.profile.id, "member");
                invalidateOperatorRolePolicy(admins[0]!.profile.id);
              },
              installAgentTurnFacade: () => {
                const methodRegistry = createRequestGatewayMethodRegistry();
                const runtime = createGatewayInstanceRuntime({
                  getContext: () => gateway,
                  getMethodRegistry: () => methodRegistry,
                  isDispatchAvailable: () => true,
                });
                agentTurnRuntime = runtime;
                gateway.createAgentTurnFacade = runtime.createAgentTurnFacade;
                gateway.recoveryRuntime = runtime.recovery;
                gateway.getGatewayMethodRegistry = () => methodRegistry;
              },
            }),
          ),
      );
      expect(sessionEventPrompts, "no ordinary session prompt").toEqual([]);
      expect(guards.embeddedRuns, "no embedded model run").toBe(0);
    } finally {
      cron.stop();
      await cron.waitForIdle();
      agentTurnRuntime?.close();
      Reflect.deleteProperty(globalThis, bridge);
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
      if (registry) {
        await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({
          failures: [],
        });
      }
      await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
    }
  });
}

function commandInvocation(fixture: Fixture, body = "/review-panel") {
  const params = fixture.params(body);
  const state = commandDispatchState(params);
  const recorder = expectDefined(state.params.replyOptions?.userTurnTranscriptRecorder, "recorder");
  params.opts = {
    withCommandNativeSubagents: (binding, run) =>
      runWithCommandNativeSubagents(state, binding, run),
  };
  return { params, state, recorder, run: () => handlePluginCommand(params, true) };
}

function commandDispatchState(
  params: HandleCommandsParams,
): Parameters<typeof runWithCommandNativeSubagents>[0] {
  const entry = expectDefined(params.sessionEntry, "command session");
  return {
    cfg: params.cfg,
    ctx: finalizeInboundContext(params.ctx),
    sessionAgentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionStoreEntry: { sessionKey: params.sessionKey, entry },
    params: {
      replyOptions: {
        runId: "command-turn",
        operatorAuthority: getCommandOwnerAuthority(params.ctx)?.operatorAuthority,
        toolsAllow: ["sessions_spawn", "agents_wait", "automations", "read"],
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
          input: { text: params.command.commandBodyNormalized },
          target: {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            sessionEntry: entry,
            storePath: params.storePath,
            config: params.cfg,
          },
        }),
      },
    },
    turnAdoption: undefined,
    getPreDispatchAbortSignal: () => undefined,
    getDispatchAbortSignal: () => params.opts?.abortSignal,
    assertProgressCurrent: () => {},
    assertCurrentBindingRoute: async () => {},
  };
}

afterEach(() => {
  guards.embeddedRuns = 0;
  guards.stubModelChoice = false;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});
function scheduleRequest(overrides: { requestId?: string; maxRuns?: number } = {}) {
  return {
    requestId: "resume",
    command: "review-panel",
    schedule: { kind: "every" as const, everyMs: 60_000 },
    deadlineAtMs: Date.now() + 300_000,
    maxRuns: 2,
    ...overrides,
  };
}
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

async function createContinuation(fixture: Fixture) {
  let accepted: { jobId: string } | undefined;
  fixture.handler.mockImplementation(async (ctx) => {
    accepted = await expectDefined(
      ctx.runtimeContext?.scheduledTurns,
      "schedule capability",
    ).schedule(scheduleRequest());
    return { text: "scheduled" };
  });
  expect((await commandInvocation(fixture).run())?.reply?.text).toBe("scheduled");
  return expectDefined(accepted, "durable native schedule").jobId;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
      const blockers: string[] = [];
      let scheduledRunId: string | undefined;
      // Hold swarm capacity so the accepted child stays queued and never reaches a model.
      fixture.onExecutionStarted = (info) => {
        const runId = expectDefined(info.runId, "scheduled occurrence run id");
        const sessionKey = expectDefined(info.sessionKey, "scheduled occurrence parent");
        scheduledRunId = runId;
        const blocker = "capacity-" + runId;
        blockers.push(blocker);
        enqueueSwarmRun({
          groupId: JSON.stringify(["main", sessionKey, "swarm:" + sessionKey + ":" + runId]),
          runId: blocker,
          maxConcurrent: 1,
          activeRunIds: [],
          start: async () => {},
          onStartFailure: () => true,
        });
      };
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
      } finally {
        for (const blocker of blockers) {
          releaseSwarmRun(blocker);
        }
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
        requesterTurnRunId: expectDefined(scheduledRunId, "scheduled occurrence run"),
      });
    });
  });
  it("admits a queued scheduled child's agent turn only while its requester stays authorized", async () => {
    guards.stubModelChoice = true;
    await withCommandPlugin(async (fixture) => {
      fixture.installAgentTurnFacade();
      const id = await createContinuation(fixture);
      const blockers: string[] = [];
      // Hold swarm capacity so each child is still queued when its occurrence settles.
      fixture.onExecutionStarted = (info) => {
        const runId = expectDefined(info.runId, "scheduled occurrence run id");
        const sessionKey = expectDefined(info.sessionKey, "scheduled occurrence parent");
        const blocker = "capacity-" + runId;
        blockers.push(blocker);
        enqueueSwarmRun({
          groupId: JSON.stringify(["main", sessionKey, "swarm:" + sessionKey + ":" + runId]),
          runId: blocker,
          maxConcurrent: 1,
          activeRunIds: [],
          start: async () => {},
          onStartFailure: () => true,
        });
      };
      const children: string[] = [];
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "scheduled native runtime");
        const child = await native.spawn({
          requestId: "scheduled-queued-" + children.length,
          task: "Synthetic scheduled child released after its occurrence settles",
          context: "isolated",
        });
        children.push(child.runId);
        return { text: "child queued" };
      });
      const releaseSettledOccurrence = async (index: number, demoteFirst: boolean) => {
        try {
          await fixture.cron.run(id, "force");
          expect(fixture.scheduledResults[index]).toMatchObject({
            status: "ok",
            outputText: "child queued",
          });
          const runId = expectDefined(children[index], "queued child run");
          expect(subagentRuns.get(runId)?.execution).toMatchObject({ status: "queued" });
          if (demoteFirst) {
            fixture.demoteOwner();
          }
        } finally {
          for (const blocker of blockers.splice(0)) {
            releaseSwarmRun(blocker);
          }
        }
        const runId = expectDefined(children[index], "queued child run");
        await vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.status).toBe("terminal"), {
          timeout: 15_000,
        });
        return subagentRuns.get(runId)?.execution.outcome;
      };
      // Authorized: after its occurrence settled, the child passed the real agent turn's
      // admission revalidation. This harness publishes no reply runtime, so the turn stops at
      // that next seam, still before the model runner (the fixture's no-embedded-run guard).
      await expect(releaseSettledOccurrence(0, false)).resolves.toMatchObject({
        status: "error",
        error: "published reply runtime missing for main",
      });
      // Demoted while queued: the next child is refused at that admission, before any runner.
      await expect(releaseSettledOccurrence(1, true)).resolves.toMatchObject({
        status: "error",
        error: "Queued channel operator authority changed; submit a new request.",
      });
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
        const entered = deferred();
        const release = deferred();
        const settled = deferred();
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
