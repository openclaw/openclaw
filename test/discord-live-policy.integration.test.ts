import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../src/channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../src/gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../src/gateway/config-reload-plan.js";
import { createLazyGatewayCronState } from "../src/gateway/server-cron-lazy.js";
import type { GatewayReloadHandlerParams } from "../src/gateway/server-reload-contracts.js";
import { createGatewayReloadHandlers } from "../src/gateway/server-reload-hot.js";
import { dispatchChannelInboundTurn } from "../src/plugin-sdk/channel-inbound.js";
import { createRuntimeTestRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  disposePluginRegistryInstances,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../src/process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";
import { createDeferred } from "./helpers/promise.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

// mock-isolation: Keep durable ingress and policy admission real; stop before model execution.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  dispatchChannelInboundTurn: vi.fn<typeof dispatchChannelInboundTurn>(),
}));

const tempDirs = createTempDirTracker();
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
let stateDir: string;
let fixtureRegistry: ReturnType<typeof createRuntimeTestRegistry>["registry"] | undefined;
let stopHandler: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.mocked(dispatchChannelInboundTurn).mockClear();
  registrySnapshot = captureActivePluginRegistrySnapshot();
  stateDir = tempDirs.make("discord-live-policy-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
  vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
});

afterEach(async () => {
  await stopHandler?.();
  stopHandler = undefined;
  if (fixtureRegistry) {
    await disposePluginRegistryInstances(
      fixtureRegistry,
      registrySnapshot.activeRegistry ?? undefined,
    );
    fixtureRegistry = undefined;
  }
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function waitForFast(callback: () => unknown) {
  return vi.waitFor(callback, { interval: 1 });
}

describe("Discord admission through Gateway policy publication", () => {
  it("admits newly allowed Discord messages during active work without restarting", async () => {
    // Describe the public calls this fixture consumes without importing plugin implementation types.
    const discord = await loadBundledPluginFacade<{
      createDiscordMessageHandler: (options: ReturnType<typeof createHandlerOptions>) => {
        (raw: ReturnType<typeof createRawMessage>, transport: typeof client): Promise<void>;
        deactivate: () => Promise<void>;
      };
      createNoopThreadBindingManager: (accountId: string) => object;
      setDiscordRuntime: (runtime: ReturnType<typeof createPluginRuntime>) => void;
    }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
    const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    });
    const cfg: OpenClawConfig = {
      plugins: { allow: ["discord"] },
      channels: { discord: { token: "synthetic-token", groupPolicy: "allowlist", guilds: {} } },
      messages: { inbound: { debounceMs: 0 } },
    };
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const api = builder.createApi(createPluginRecord({ id: "discord", origin: "bundled" }), {
      config: cfg,
      registrationMode: "full",
    });
    api.registerChannel({ plugin: discordPlugin });
    const registry = builder.registry;
    fixtureRegistry = registry;
    setActivePluginRegistry(registry);
    setRuntimeConfigSnapshot(cfg, cfg);
    discord.setDiscordRuntime(api.runtime);
    const queue = api.runtime.state.openChannelIngressQueue({ accountId: "default" });
    const waitForIngress = async () => {
      // Admission ends at enqueue; observe settlement before asserting a policy denied delivery.
      await waitForFast(async () =>
        expect(await queue.listUnsettled?.()).toEqual({ pending: [], claims: [] }),
      );
      expect(await queue.listFailed?.()).toEqual([]);
    };
    let channelId = "456";
    let pendingChannelLookup: Promise<void> | undefined;
    let channelLookupStarted = false;
    const guildId = "123";
    const userId = "789";
    // The synthetic transport supplies only metadata lookups; preflight stays real.
    const client = {
      fetchChannel: async () => {
        channelLookupStarted = true;
        await pendingChannelLookup;
        return { id: channelId, type: 0, name: "synthetic" };
      },
      fetchGuild: async () => null,
    };
    const dispatchStarted = createDeferred();
    vi.mocked(dispatchChannelInboundTurn).mockImplementation(async () => {
      dispatchStarted.resolve();
      return { admission: { kind: "handled", reason: "test-fixture" }, dispatched: false };
    });
    const admitted = () =>
      vi
        .mocked(dispatchChannelInboundTurn)
        .mock.calls.map(([params]) => params.ctxPayload.MessageSid);
    const abort = new AbortController();
    const createHandlerOptions = (threadBindings: object) => ({
      client,
      cfg,
      discordConfig: cfg.channels?.discord,
      accountId: "default",
      token: "synthetic-token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code: number) => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      botUserId: "999",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000,
      textLimit: 2_000,
      replyToMode: "off",
      dmEnabled: true,
      dmPolicy: "pairing",
      groupDmEnabled: false,
      guildEntries: {},
      threadBindings,
      abortSignal: abort.signal,
    });
    const createRawMessage = (id: string) => ({
      id,
      channel_id: channelId,
      guild_id: guildId,
      content: "hello",
      author: { id: userId, username: "synthetic", discriminator: "0" },
      timestamp: "2026-09-06T00:00:00.000Z",
      type: 0,
    });
    const handler = discord.createDiscordMessageHandler(
      createHandlerOptions(discord.createNoopThreadBindingManager("default")),
    );
    stopHandler = async () => {
      abort.abort();
      await handler.deactivate();
    };
    const send = (id: string) => handler(createRawMessage(id), client);
    const startChannel = vi.fn(async () => new Map());
    const stopChannel = vi.fn(async () => {});
    const scheduler = createTestGatewayScheduler();
    let state: ReturnType<GatewayReloadHandlerParams["getState"]> = {
      hooksConfig: null,
      hookClientIpConfig: { allowRealIpFallback: false },
      cronState: createLazyGatewayCronState({
        scheduler,
        storePath: path.join(stateDir, "cron", "jobs.json"),
        cfg,
        deps: {},
        broadcast: vi.fn(),
      }),
    };
    const { applyHotReload } = createGatewayReloadHandlers({
      scheduler,
      deps: {},
      broadcast: vi.fn(),
      getPluginRegistry: () => registry,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      startChannel,
      stopChannel,
      releaseChannelRouteHandoffs: vi.fn(),
      pruneInactiveChannelAccountState: vi.fn(),
      reloadPlugins: async () => {
        throw new Error("policy edit must not reload plugins");
      },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      cronReconciliation: { arm: () => ({ complete: async () => {} }), invalidate: vi.fn() },
    });
    let pendingReload: Promise<unknown> | undefined;
    let committed = cfg;
    const apply = async (next: OpenClawConfig) => {
      const paths = diffGatewayReloadPaths(committed, next, listConfigReloadRefinementPrefixes());
      const plan = buildGatewayReloadPlan(paths, {
        previousConfig: committed,
        candidateConfig: next,
      });
      pendingReload = applyHotReload(plan, next, {
        sourceConfig: next,
        isCurrent: () => true,
        publish: async (commit) => {
          setRuntimeConfigSnapshot(next, next);
          await commit();
          committed = next;
        },
      });
      await waitForFast(() =>
        expect(committed, "policy-only publication must not wait for the active turn").toBe(next),
      );
      expect(await pendingReload).toBe("applied");
    };
    const activeTurn = tryBeginGatewayRootWorkAdmission();
    expect(activeTurn).not.toBeNull();
    try {
      await send("before-policy");
      await waitForIngress();
      expect(admitted()).toEqual([]);
      await apply({
        ...cfg,
        channels: {
          discord: {
            ...cfg.channels?.discord,
            guilds: {
              [guildId]: { users: [userId], requireMention: false },
            },
          },
        },
      });
      await send("newly-allowed");
      await dispatchStarted.promise;
      expect(admitted()).toEqual(["newly-allowed"]);
      channelId = "457";
      channelLookupStarted = false;
      const lookup = createDeferred();
      pendingChannelLookup = lookup.promise;
      const pendingMessage = send("pending-revocation");
      try {
        await waitForFast(() => expect(channelLookupStarted).toBe(true));
        await apply(cfg);
      } finally {
        lookup.resolve();
        await pendingMessage;
      }
      await waitForIngress();
      pendingChannelLookup = undefined;
      await send("after-revocation");
      await waitForIngress();
      expect(admitted()).toEqual(["newly-allowed"]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(startChannel).not.toHaveBeenCalled();
      expect(stopChannel).not.toHaveBeenCalled();
    } finally {
      activeTurn?.release();
      await pendingReload?.catch(() => {});
    }
  });
});
