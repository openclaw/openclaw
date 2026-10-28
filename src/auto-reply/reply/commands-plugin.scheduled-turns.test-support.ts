// Real-loader fixture; callers own their module mocks.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { createAccountListHelpers } from "../../channels/plugins/account-helpers.js";
import type { ChannelGroupContext } from "../../channels/plugins/types.core.js";
import {
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
import { createGatewayCronAgentDeps } from "../../gateway/server-cron-agent-run.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import { getPluginInstanceIncarnation } from "../../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { unlinkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import {
  createPersistedPluginCommandParams,
  createPluginCommandInvocation,
} from "./commands-plugin.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
export const pluginId = "command-controller";

type AdminIngressFixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
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
  demoteOwner: () => void;
  removeOwner: () => void;
  installAgentTurnFacade: () => void;
  readJobs: () => Promise<import("../../cron/types.js").CronStoredJob[]>;
  /** The scheduler of the current Gateway process; replaced by `restart`. */
  readonly cron: CronService;
  /** Retires the old runtime, applies changes, then recovers a scheduler on the same database. */
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

// Only the application handler crosses the bridge; registration and authority use real owners.
// Bundled fixtures are discovered in a built package's dist/extensions.
export async function withCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    commands?: CommandMetadata[];
    manifestCapabilities?: unknown;
    scheduledContract?: boolean;
    bundled?: boolean;
    /** Parent session key of the requester; defaults to a channel conversation. */
    sessionKey?: string;
  } = {},
) {
  const body = async ({ cfg, state, admins, context, gateway }: AdminIngressFixture) => {
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
      `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
        for (const command of ${JSON.stringify(commands)}) {
          api.registerCommand({ ...command, description: "Synthetic review command", acceptsArgs: true,
            handler(ctx) { return globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridge))})](ctx); }
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
    // A loaded Discord channel lists the configured accounts and resolves conversation tool
    // policy like extensions/discord/src/group-policy.ts: the account's guilds, else the
    // channel's; a run without a guild id selects only the "*" guild.
    const discord = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: { listAccountIds: createAccountListHelpers("discord").listAccountIds },
      }),
      groups: {
        resolveToolPolicy: ({ cfg: current, accountId, groupId }: ChannelGroupContext) => {
          const config = current.channels?.discord;
          const guilds =
            (accountId ? config?.accounts?.[accountId]?.guilds : undefined) ?? config?.guilds;
          const guild = guilds?.["*"];
          return (groupId ? guild?.channels?.[groupId]?.tools : undefined) ?? guild?.tools;
        },
      },
    };
    let registry: PluginRegistry | undefined;
    const loadPlugin = () => {
      registry = loadOpenClawPlugins({
        config: cfg,
        workspaceDir: state.workspaceDir,
        cache: false,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      registry.channels.push({ pluginId: discord.id, source: "test", plugin: discord });
      setActivePluginRegistry(registry);
      return registry;
    };
    const disposePlugin = () =>
      expect(
        disposePluginRegistryInstances(expectDefined(registry, "previous registry")),
      ).resolves.toMatchObject({ failures: [] });
    const reloadPlugin = async () => {
      await disposePlugin();
      loadPlugin();
    };
    let agentTurnRuntime: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
    const scheduledResults: Fixture["scheduledResults"] = [];
    const sessionEventPrompts: string[] = [];
    let fixtureRef: Fixture | undefined;
    const runSchedulerOwned = createScheduledGatewayRunner(
      () => gateway,
      () => registry,
    );
    const gatewayCronAgentDeps = createGatewayCronAgentDeps({
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
        resolvePluginCommandScheduleHosts: gatewayCronAgentDeps.resolvePluginCommandScheduleHosts,
        runIsolatedAgentJob: async (request) => {
          const result = await gatewayCronAgentDeps.runIsolatedAgentJob({
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
    const params = createPersistedPluginCommandParams(cfg, inbound, state, sessionKey, storePath);
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
      const loadedRegistry = loadPlugin();
      if (
        options.commands === undefined &&
        options.manifestCapabilities === undefined &&
        options.scheduledContract !== false
      ) {
        expect(
          loadedRegistry.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
          "the valid declaring plugin must load without registration refusals",
        ).toEqual([]);
      }
      const fixture: Fixture = {
        cfg,
        get cron() {
          return cron;
        },
        scheduledResults,
        bundledBuildInfoPath: bundledDist && path.join(bundledDist, "build-info.json"),
        restart: async (change) => {
          cron.stop();
          await cron.waitForIdle();
          await disposePlugin();
          await change?.(cfg, pluginDir);
          loadPlugin();
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
        registry: loadedRegistry,
        reloadPlugin,
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
      };
      fixtureRef = fixture;
      await withPluginRuntimeGatewayRequestScope(
        {
          context: gateway,
          resolveGatewayContext: () => gateway,
          pluginRegistry: loadedRegistry,
          isWebchatConnect: () => false,
        },
        () => run(fixture),
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
        await disposePlugin();
      }
      await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
    }
  };
  await withAdminIngress(body, "role", "discord", options.sessionKey);
}

export function commandInvocation(fixture: Fixture, body = "/review-panel") {
  return createPluginCommandInvocation(fixture.params(body), [
    "sessions_spawn",
    "agents_wait",
    "automations",
    "read",
  ]);
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
