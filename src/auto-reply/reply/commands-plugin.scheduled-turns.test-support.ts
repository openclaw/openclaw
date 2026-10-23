// Shared real-loader fixture for requester-admitted scheduled command tests. Test files own
// their module mocks; see commands-plugin.scheduled-turns.test.ts.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import { listPluginCommandScheduleHosts } from "../../plugins/plugin-command-schedule-hosts.js";
import { getPluginInstanceIncarnation } from "../../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { unlinkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { runWithCommandNativeSubagents } from "./dispatch-native-subagent.js";
import { finalizeInboundContext } from "./inbound-context.js";
export const pluginId = "command-controller";

type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type CommandMetadata = {
  name: string;
  requireAuth?: boolean;
  runtimeCapabilities?: unknown;
  channels?: string[];
};
export const declaredCommand: CommandMetadata = {
  name: "review-panel",
  requireAuth: true,
  runtimeCapabilities: ["subagents", "scheduledTurns"],
};

export type Fixture = {
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
  /** Unlinks the requester's channel identity from its operator profile, then publishes it. */
  removeOwner: () => void;
  /** Lets a launched child reach its agent turn through the real Gateway instance runtime. */
  installAgentTurnFacade: () => void;
  readJobs: () => Promise<import("../../cron/types.js").CronStoredJob[]>;
  /** The scheduler of the current Gateway process; replaced by `restart`. */
  readonly cron: CronService;
  /**
   * Restarts the Gateway in-process: the scheduler stops, plugin instances retire, `change` may
   * edit config or plugin files (and the caller's mocked process identity), then plugins load and
   * a new scheduler starts on the same state database through its startup recovery.
   */
  restart: (
    change?: (cfg: OpenClawConfig, pluginDir: string) => Promise<void> | void,
  ) => Promise<void>;
  /** The live loaded instance identity of the fixture plugin. */
  pluginIncarnation: () => string | undefined;
  /** For a `bundled` fixture, the build record of the package that ships the plugin. */
  bundledBuildInfoPath?: string;
  scheduledResults: Array<Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>>;
  resetParent: () => Promise<unknown>;
  reloadPlugin: () => Promise<void>;
  onExecutionStarted?: (info: CronAgentExecutionStarted) => void;
};

// The fixture is a third-party plugin loaded from disk, not an injected registry record.
// Only its application handler crosses this bridge; registration, selection, authority,
// native tool policy, and command lifetime all use their production owners. With `bundled`, the
// same plugin is discovered as a core-bundled plugin inside a built package's `dist/extensions`,
// loading host-owned modules without captured source.
export async function withCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    commands?: CommandMetadata[];
    manifestCapabilities?: unknown;
    scheduledContract?: boolean;
    bundled?: boolean;
  } = {},
) {
  await withAdminIngress(async ({ cfg, state, admins, context, gateway }) => {
    // The test state restores both bundled-plugin variables when it ends.
    const bundledDist = options.bundled ? state.path("openclaw-package", "dist") : undefined;
    if (bundledDist) {
      await fs.mkdir(path.join(bundledDist, "extensions"), { recursive: true });
      setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(bundledDist, "extensions"));
      deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    }
    const bridge = Symbol.for(`openclaw.command-native-test.${randomUUID()}`);
    const handler = vi.fn<Handler>((ctx) => ({
      text: JSON.stringify({
        subagents: ctx.runtimeContext?.subagents !== undefined,
        args: ctx.args,
      }),
    }));
    Reflect.set(globalThis, bridge, handler);
    const pluginDir = bundledDist
      ? path.join(bundledDist, "extensions", pluginId)
      : state.path("controller-plugin");
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
      ...(bundledDist ? {} : { load: { paths: [pluginFile] } }),
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
      storePath: cronStorePath,
      resolveCronAgent: () => ({ agentId: "main", cfg }),
      resolveGatewayContext: () => gateway,
      resolvePluginRegistry: () => registry,
    });
    const createCron = () =>
      new CronService({
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
        resolvePluginCommandScheduleHosts: () => listPluginCommandScheduleHosts(registry),
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
    let cron = createCron();
    const bindGateway = () =>
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
    bindGateway();
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
              get cron() {
                return cron;
              },
              scheduledResults,
              bundledBuildInfoPath: bundledDist && path.join(bundledDist, "build-info.json"),
              restart: async (change) => {
                cron.stop();
                await cron.waitForIdle();
                await expect(
                  disposePluginRegistryInstances(expectDefined(registry, "previous registry")),
                ).resolves.toMatchObject({ failures: [] });
                await change?.(cfg, pluginDir);
                registry = loadOpenClawPlugins({
                  config: cfg,
                  workspaceDir: state.workspaceDir,
                  cache: false,
                  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
                });
                setActivePluginRegistry(registry);
                cron = createCron();
                bindGateway();
                await cron.start();
              },
              pluginIncarnation: () => {
                const record = registry?.plugins.find((plugin) => plugin.id === pluginId);
                return record && getPluginInstanceIncarnation(record);
              },
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
              removeOwner: () => {
                unlinkUserChannelIdentity(admins[0]!.profile.id, admins[0]!.identity);
                invalidateOperatorRolePolicy(admins[0]!.profile.id);
              },
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

export function commandInvocation(fixture: Fixture, body = "/review-panel") {
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

export function scheduleRequest(overrides: { requestId?: string; maxRuns?: number } = {}) {
  return {
    requestId: "resume",
    command: "review-panel",
    schedule: { kind: "every" as const, everyMs: 60_000 },
    deadlineAtMs: Date.now() + 300_000,
    maxRuns: 2,
    ...overrides,
  };
}

export async function createContinuation(fixture: Fixture) {
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
