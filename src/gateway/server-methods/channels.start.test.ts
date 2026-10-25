import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getChannelPlugin as getRegisteredChannelPlugin } from "../../channels/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { createChannelManager } from "../server-channels.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

import { channelsHandlers } from "./channels.js";

const selection = { channel: "whatsapp", accountId: "default-account" };
const accountConfig = {
  defaultAccountId: () => selection.accountId,
  listAccountIds: () => [selection.accountId],
  resolveAccount: () => ({}),
};
const pluginBase = { id: "whatsapp", config: accountConfig };

function createChannelRuntimeSnapshot(running: boolean): ChannelRuntimeSnapshot {
  const account = { accountId: selection.accountId, running };
  return {
    channels: { whatsapp: account },
    channelAccounts: { whatsapp: { [selection.accountId]: { ...account } } },
  };
}

function createOptions(
  params: Record<string, unknown> = { channel: "whatsapp" },
  context: Partial<GatewayRequestHandlerOptions["context"]> = {},
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      markChannelLoggedOut: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(true)),
      ...context,
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function invoke(action: "start" | "stop" | "logout", options: GatewayRequestHandlerOptions) {
  return expectDefined(channelsHandlers[`channels.${action}`], "channel control handler")(options);
}

function expectReply(respond: GatewayRequestHandlerOptions["respond"], payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectFailure(respond: GatewayRequestHandlerOptions["respond"], message: unknown) {
  const error = expect.objectContaining({ code: "UNAVAILABLE", message });
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}

async function waitForAbort({ abortSignal }: { abortSignal: AbortSignal }) {
  await new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createManager(
  getPluginRegistry: Parameters<typeof createChannelManager>[0]["getPluginRegistry"],
) {
  return createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: mocks.getRuntimeConfig,
    getPluginRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
}

async function runLogout(logoutAccount: ReturnType<typeof vi.fn>, stopChannel = vi.fn()) {
  mocks.getChannelPlugin.mockReturnValue({ ...pluginBase, gateway: { logoutAccount } });
  const options = createOptions(undefined, { stopChannel, isConfigReloadSettled: () => true });
  await invoke("logout", options);
  return { ...options, stopChannel, markChannelLoggedOut: options.context.markChannelLoggedOut };
}

it("explains a successful manual start while configuration publication is deferred", async () => {
  vi.clearAllMocks();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.getChannelPlugin.mockReturnValue({ ...pluginBase, gateway: { startAccount: vi.fn() } });
  const startChannel = vi.fn<GatewayRequestHandlerOptions["context"]["startChannel"]>(
    async () => new Map([[selection.accountId, { status: "handed-off" }]]),
  );
  const options = createOptions(undefined, {
    startChannel,
    getDeferredChannelReloads: () => [{ channel: "whatsapp", publicationPending: true }],
  });
  await invoke("start", options);
  expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account", { manual: true });
  expectReply(
    options.respond,
    expect.objectContaining({
      started: true,
      statusIssues: [
        expect.objectContaining({
          ...selection,
          kind: "config",
          message: expect.stringContaining("previous configuration is still in use"),
        }),
      ],
    }),
  );
});

describe("channelsHandlers channels.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const token = { source: "env", provider: "default", id: "WHATSAPP_TOKEN" };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { channels: { whatsapp: { token } } },
    });
  });

  it.each([
    { changed: "config", phase: "preparation" },
    { changed: "registration", phase: "preparation" },
    { changed: "config", phase: "stop" },
    { changed: "registration", phase: "stop" },
    { changed: "config", phase: "completion" },
    { changed: "registration", phase: "completion" },
    { changed: "reload", phase: "completion" },
    { changed: "runtime", phase: "completion" },
  ])(
    "preserves the successor when $changed changes during logout $phase",
    async ({ changed, phase }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let pause = false;
      let reloadSettled = true;
      const pauseAt = async (stage: string) => {
        if (pause && phase === stage) {
          entered.resolve();
          await release.promise;
        }
      };
      const logoutAccount = vi.fn(async () => {
        await pauseAt("completion");
        return { cleared: true, loggedOut: true };
      });
      const plugin = {
        ...createChannelTestPluginBase({
          id: "whatsapp",
          config: {
            listAccountIds: () => ["default-account"],
            resolveAccountAsync: async (_cfg, accountId) => {
              await pauseAt("preparation");
              return { accountId, enabled: true, configured: true };
            },
            isConfigured: () => true,
          },
        }),
        gateway: {
          startAccount: waitForAbort,
          stopAccount: async () => undefined,
          logoutAccount,
        },
      };
      let registry = createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]);
      const requestRegistry = registry;
      let methodRegistry = createGatewayMethodRegistry([], registry);
      setActivePluginRegistry(registry);
      mocks.getChannelPlugin.mockImplementation(getRegisteredChannelPlugin);
      mocks.getRuntimeConfig.mockReturnValue({ channels: { whatsapp: { name: "original" } } });
      const manager = createManager(() => registry);
      const options = createOptions(selection, {
        getGatewayMethodRegistry: () => methodRegistry,
        isConfigReloadSettled: () => reloadSettled,
        markChannelLoggedOut: vi.fn(manager.markChannelLoggedOut),
        stopChannel: async (channelId, accountId) => {
          await manager.stopChannel(channelId, accountId);
          await pauseAt("stop");
        },
      });
      let pending: Promise<void> | undefined;
      try {
        await manager.startChannel("whatsapp", "default-account");
        pause = true;
        pending = withPluginRuntimeRegistryScope(requestRegistry, async () =>
          invoke("logout", options),
        );
        await entered.promise;
        pause = false;
        await manager.stopChannel("whatsapp", "default-account");
        if (changed === "config") {
          mocks.getRuntimeConfig.mockReturnValue({ channels: { whatsapp: { name: "successor" } } });
        } else if (changed === "registration") {
          const successor = { ...plugin, gateway: { ...plugin.gateway } };
          registry = createTestRegistry([
            { pluginId: "whatsapp", plugin: successor, source: "test" },
          ]);
          methodRegistry = createGatewayMethodRegistry([], registry);
          setActivePluginRegistry(registry);
        } else if (changed === "reload") {
          reloadSettled = false;
        }
        await manager.startChannel("whatsapp", "default-account", { manual: true });
        release.resolve();
        await pending;

        expect(
          manager.getRuntimeSnapshot().channelAccounts.whatsapp?.["default-account"]?.running,
        ).toBe(true);
        if (changed !== "runtime") {
          expect(options.context.markChannelLoggedOut).not.toHaveBeenCalled();
        }
        if (phase === "completion") {
          expect(logoutAccount).toHaveBeenCalledOnce();
          expectReply(options.respond, expect.objectContaining({ cleared: true, loggedOut: true }));
        } else {
          expect(logoutAccount).not.toHaveBeenCalled();
          expectFailure(options.respond, expect.stringContaining("changed"));
        }
      } finally {
        pause = false;
        release.resolve();
        await pending;
        await manager.stopChannel("whatsapp");
        resetPluginRuntimeStateForTest();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("passes the active runtime config to channel plugins", async () => {
    const runtimeConfig = { channels: { whatsapp: { token: "runtime-token" } } };
    const logoutAccount = vi.fn(async ({ cfg }: { cfg: typeof runtimeConfig }) => {
      expect(cfg.channels.whatsapp.token).toBe("runtime-token");
      return { cleared: true, envToken: false, loggedOut: true };
    });
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    const { respond, stopChannel, markChannelLoggedOut } = await runLogout(logoutAccount);

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(markChannelLoggedOut).toHaveBeenCalledWith("whatsapp", true, "default-account");
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expectReply(respond, {
      ...selection,
      cleared: true,
      envToken: false,
      loggedOut: true,
    });
  });

  it("does not clear channel auth when runtime teardown fails", async () => {
    const stopChannel = vi.fn(async () => {
      throw new Error("stop failed");
    });
    const logoutAccount = vi.fn(async () => ({ cleared: true, loggedOut: true }));
    const { respond, markChannelLoggedOut } = await runLogout(logoutAccount, stopChannel);

    expect(logoutAccount).not.toHaveBeenCalled();
    expect(markChannelLoggedOut).not.toHaveBeenCalled();
    expectFailure(respond, "Error: stop failed");
  });
});

it("stops the recorded default account while plugin callbacks are paused", async () => {
  const refuse = vi.fn(() => {
    throw new Error("plugin is quiesced");
  });
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.getChannelPlugin.mockReturnValue({
    id: "whatsapp",
    config: { defaultAccountId: refuse, listAccountIds: refuse, resolveAccount: refuse },
  });
  const stopChannel = vi.fn(async () => undefined);
  const options = createOptions(undefined, {
    stopChannel,
    getRuntimeSnapshot: () => ({
      ...createChannelRuntimeSnapshot(false),
      reloadingChannels: new Map([["whatsapp", "default-account"]]),
    }),
  });
  await invoke("stop", options);
  expect(stopChannel).toHaveBeenCalledExactlyOnceWith("whatsapp", "default-account");
  expectReply(options.respond, { ...selection, stopped: true });
  expect(refuse).not.toHaveBeenCalled();
});

it.each(["start", "stop"] as const)(
  "controls the default account on %s without inspecting another configured account",
  async (action) => {
    const inspectAccount = vi.fn((_cfg: unknown, accountId?: string | null) => {
      if (accountId === "diagnostic-only") {
        throw new Error("diagnostic inspector unavailable");
      }
      return { accountId, enabled: true, configured: true };
    });
    const plugin = {
      ...createChannelTestPluginBase({
        id: "whatsapp",
        config: {
          defaultAccountId: () => "default-account",
          listAccountIds: () => ["default-account", "diagnostic-only"],
          resolveAccount: (_cfg, accountId) => ({ accountId, enabled: true }),
          isConfigured: () => true,
          inspectAccount,
        },
      }),
      gateway: { startAccount: waitForAbort, stopAccount: async () => undefined },
    };
    const registry = createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]);
    setActivePluginRegistry(registry);
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.getChannelPlugin.mockReturnValue(plugin);
    const manager = createManager(() => registry);
    const startChannel = vi.spyOn(manager, "startChannel");
    const stopChannel = vi.spyOn(manager, "stopChannel");
    try {
      if (action === "stop") {
        await manager.startChannel("whatsapp", "default-account");
      }
      const options = createOptions(undefined, {
        startChannel,
        stopChannel,
        getRuntimeSnapshot: manager.getRuntimeSnapshot,
      });
      await invoke(action, options);
      expect(action === "start" ? startChannel : stopChannel).toHaveBeenCalledWith(
        "whatsapp",
        "default-account",
        ...(action === "start" ? [{ manual: true }] : []),
      );
      expectReply(
        options.respond,
        expect.objectContaining({
          ...selection,
          [action === "start" ? "started" : "stopped"]: true,
        }),
      );
      expect(inspectAccount).not.toHaveBeenCalled();
    } finally {
      await manager.stopChannel("whatsapp");
      resetPluginRuntimeStateForTest();
      resetGatewayWorkAdmission();
    }
  },
);
