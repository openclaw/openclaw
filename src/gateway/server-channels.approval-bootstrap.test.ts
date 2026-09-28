/**
 * Server channel approval bootstrap tests.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { GatewayRequestFn } from "../infra/approval-native-route-notice.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginRegistry,
  requireActivePluginChannelRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const hoisted = vi.hoisted(() => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: hoisted.startChannelApprovalHandlerBootstrap,
}));

function createTestPlugin(params: {
  startAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;
  channelId?: ChannelId;
  accountId?: string;
}): ChannelPlugin {
  const channelId = params.channelId ?? "discord";
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    id: channelId,
    meta: {
      id: channelId,
      label: channelId,
      selectionLabel: channelId,
      docsPath: `/channels/${channelId}`,
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [accountId],
      resolveAccount: () => ({ enabled: true, configured: true }),
      isEnabled: () => true,
      describeAccount: () => ({
        accountId,
        enabled: true,
        configured: true,
      }),
    },
    approvalCapability: {
      nativeRuntime: {
        availability: {
          isConfigured: vi.fn().mockReturnValue(true),
          shouldHandle: vi.fn().mockReturnValue(true),
        },
        presentation: {
          buildPendingPayload: vi.fn(),
          buildResolvedResult: vi.fn(),
          buildExpiredResult: vi.fn(),
        },
        transport: {
          prepareTarget: vi.fn(),
          deliverPending: vi.fn(),
        },
      },
    },
    gateway: {
      startAccount: params.startAccount,
    },
  };
}

function installTestRegistry(...plugins: ChannelPlugin[]) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push(
    ...plugins.map((plugin) => ({
      pluginId: plugin.id,
      source: "test",
      plugin,
    })),
  );
  setActivePluginRegistry(registry);
}

function createManager(
  createChannelManager: typeof import("./server-channels.js").createChannelManager,
  options?: {
    channelRuntime?: PluginRuntime["channel"];
    nativeApprovalRuntime?: GatewayNativeApprovalRuntime;
    getRuntimeConfig?: () => OpenClawConfig;
  },
) {
  const log = createSubsystemLogger("gateway/server-channels-approval-bootstrap-test");
  const channelLogs = { discord: log, slack: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime, slack: runtime } as unknown as Record<
    ChannelId,
    RuntimeEnv
  >;
  return createChannelManager({
    getRuntimeConfig: options?.getRuntimeConfig ?? (() => ({})),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.nativeApprovalRuntime
      ? { getNativeApprovalRuntime: () => options.nativeApprovalRuntime }
      : {}),
  });
}

describe("server-channels approval bootstrap", () => {
  let previousRegistry: PluginRegistry | null = null;
  let createChannelManager: typeof import("./server-channels.js").createChannelManager;

  beforeAll(async () => {
    ({ createChannelManager } = await import("./server-channels.js"));
  });

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    hoisted.startChannelApprovalHandlerBootstrap.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("starts and stops the shared approval bootstrap with the channel lifecycle", async () => {
    const channelRuntime = createRuntimeChannel();
    const stopApprovalBootstrap = vi.fn(async () => {});
    const nativeApprovalRuntime = {
      request: vi.fn(),
      requestRoute: vi.fn(),
      routeCoordinator: {} as never,
      subscribe: vi.fn(),
    } as GatewayNativeApprovalRuntime;
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(stopApprovalBootstrap);

    const started = createDeferred();
    const stopped = createDeferred();
    const startAccount = vi.fn(
      async ({
        abortSignal,
        channelRuntime: channelRuntimeLocal,
      }: Parameters<NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>>[0]) => {
        expect(getGatewayNativeApprovalRuntime()).toBeDefined();
        expect(getGatewayNativeApprovalRuntime()).not.toBe(nativeApprovalRuntime);
        channelRuntimeLocal?.runtimeContexts.register({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.native",
          context: { token: "tracked" },
        });
        started.resolve();
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, {
      channelRuntime,
      nativeApprovalRuntime,
    });

    await manager.startChannels();
    await started.promise;

    const approvalBootstrapCalls = hoisted.startChannelApprovalHandlerBootstrap.mock
      .calls as unknown as Array<
      [
        {
          plugin: ChannelPlugin;
          cfg: unknown;
          accountId?: string;
          channelRuntime?: PluginRuntime["channel"];
          gatewayRuntime?: GatewayNativeApprovalRuntime;
        },
      ]
    >;
    const approvalBootstrapArg = approvalBootstrapCalls.at(-1)?.[0];
    expect(approvalBootstrapArg?.plugin.id).toBe("discord");
    expect(approvalBootstrapArg?.cfg).toEqual({});
    expect(approvalBootstrapArg?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(approvalBootstrapArg?.gatewayRuntime).toBeDefined();
    expect(approvalBootstrapArg?.gatewayRuntime).not.toBe(nativeApprovalRuntime);
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.register).toBe("function");
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.get).toBe("function");
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.watch).toBe("function");
    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
      }),
    ).toEqual({ token: "tracked" });

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await stopped.promise;

    expect(stopApprovalBootstrap).toHaveBeenCalledTimes(1);
    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
      }),
    ).toBeUndefined();
  });

  it("keeps requester excerpts within the host-owned Slack account", async () => {
    const cfg: OpenClawConfig = {};
    const request: PluginApprovalRequest = {
      approvalKind: "plugin",
      id: "plugin:replay-private",
      request: {
        title: "Sensitive action",
        description: "Needs approval",
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
        turnSourceTo: "user:U123",
        approvalSource: {
          channel: "slack",
          senderId: "U123",
          userMessageExcerpt: "private original message",
        },
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const context = {
      getRuntimeConfig: () => cfg,
      pluginApprovalManager: {
        listLocalPendingRecords: () => [request],
        getLiveSnapshot: () => null,
        retainForHandoff: () => () => {},
      },
    } as unknown as GatewayRequestContext;
    const gateway = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    const discordOnRequested = vi.fn();
    const slackOnRequested = vi.fn();
    const discordOriginCurrent = vi.fn(() => true);
    const discordSubscriber = {
      eventKinds: new Set(["plugin"] as const),
      channel: "slack",
      accountId: "work",
      shouldHandle: () => true,
      onRequested: discordOnRequested,
      onResolved: vi.fn(),
    };
    const slackSubscriber = { ...discordSubscriber, onRequested: slackOnRequested };
    const discordStarted = createDeferred();
    const slackStarted = createDeferred();
    const slackAborted = createDeferred();
    const releaseSlack = createDeferred();
    let discordRuntime: GatewayNativeApprovalRuntime | undefined;
    let slackRuntime: GatewayNativeApprovalRuntime | undefined;
    let sourceReporter:
      | ReturnType<GatewayNativeApprovalRuntime["routeCoordinator"]["createReporter"]>
      | undefined;
    const startSubscriber =
      (
        subscriber: typeof discordSubscriber,
        started: () => void,
        options?: {
          onRuntime?: (runtime: GatewayNativeApprovalRuntime) => void;
          onAbort?: () => void;
          holdAfterAbort?: Promise<void>;
        },
      ): NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]> =>
      async ({ abortSignal }) => {
        const runtime = getGatewayNativeApprovalRuntime();
        if (!runtime) {
          throw new Error("channel account did not receive its Gateway approval runtime");
        }
        options?.onRuntime?.(runtime);
        runtime.subscribe(subscriber);
        started();
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              options?.onAbort?.();
              resolve();
            },
            { once: true },
          );
        });
        await options?.holdAfterAbort;
      };
    installTestRegistry(
      createTestPlugin({
        channelId: "discord",
        startAccount: startSubscriber(discordSubscriber, () => discordStarted.resolve(), {
          onRuntime: (runtime) => {
            discordRuntime = runtime;
            runtime.routeCoordinator
              .createReporter({
                handledKinds: new Set(["plugin"]),
                channel: "slack",
                accountId: "work",
                isOriginCurrent: discordOriginCurrent,
                requestGateway: async () => {},
                shouldHandle: () => false,
                classifyRoute: () => "unbound",
              })
              .start();
          },
        }),
      }),
      createTestPlugin({
        channelId: "slack",
        accountId: "work",
        startAccount: startSubscriber(slackSubscriber, () => slackStarted.resolve(), {
          onRuntime: (runtime) => {
            slackRuntime = runtime;
          },
          onAbort: () => slackAborted.resolve(),
          holdAfterAbort: releaseSlack.promise,
        }),
      }),
    );
    const manager = createManager(createChannelManager, {
      channelRuntime: createRuntimeChannel(),
      nativeApprovalRuntime: gateway.nativeApprovals,
      getRuntimeConfig: () => cfg,
    });
    const publicRequest = {
      ...request,
      request: {
        ...request.request,
        approvalSource: { channel: "slack", senderId: "U123" },
      },
    };
    try {
      await manager.startChannels();
      await Promise.all([discordStarted.promise, slackStarted.promise]);

      expect(discordOnRequested).toHaveBeenNthCalledWith(1, publicRequest);
      expect(slackOnRequested).toHaveBeenNthCalledWith(1, request);

      const liveRequest = { ...request, id: "plugin:live-private" };
      gateway.approvalEvents.publishRequested("plugin", liveRequest);
      expect(discordOnRequested).toHaveBeenNthCalledWith(2, {
        ...publicRequest,
        id: liveRequest.id,
      });
      expect(slackOnRequested).toHaveBeenNthCalledWith(2, liveRequest);
      expect(discordOriginCurrent).not.toHaveBeenCalled();

      if (!slackRuntime) {
        throw new Error("Slack account did not receive its Gateway approval runtime");
      }
      const sourceSend = vi.fn<GatewayRequestFn>(async () => {});
      sourceReporter = slackRuntime.routeCoordinator.createReporter({
        handledKinds: new Set(["plugin"]),
        channel: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        requestGateway: sourceSend,
        shouldHandle: () => false,
        classifyRoute: () => "unbound",
      });
      sourceReporter.start();
      const hostOwned = { ...request, id: "plugin:host-owned-origin" };
      gateway.nativeApprovals.routeCoordinator.capturePluginOrigin(hostOwned);
      await gateway.nativeApprovals.routeCoordinator.finishPluginOriginRouting(hostOwned.id, false);
      expect(sourceSend).toHaveBeenCalledTimes(1);
      const hostGuard = sourceSend.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
      expect(hostGuard?.(cfg)).toBe(true);

      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      const stoppedDiscordRuntime = discordRuntime;
      if (!stoppedDiscordRuntime) {
        throw new Error("discord account did not receive its Gateway approval runtime");
      }
      expect(() => stoppedDiscordRuntime.subscribe(discordSubscriber)).toThrow(/no longer active/);

      gateway.approvalEvents.publishRequested("plugin", {
        ...request,
        id: "plugin:after-discord-stop",
      });
      expect(discordOnRequested).toHaveBeenCalledTimes(2);
      expect(slackOnRequested).toHaveBeenCalledTimes(3);
      expect(discordOriginCurrent).not.toHaveBeenCalled();

      const stopSlack = manager.stopChannel("slack", "work");
      await slackAborted.promise;
      expect(hostGuard?.(cfg)).toBe(false);
      gateway.approvalEvents.publishRequested("plugin", {
        ...request,
        id: "plugin:after-slack-abort",
      });
      expect(slackOnRequested).toHaveBeenCalledTimes(3);
      releaseSlack.resolve();
      await stopSlack;
    } finally {
      releaseSlack.resolve();
      await sourceReporter?.stop();
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      await manager.stopChannel("slack", "work");
      gateway.close();
    }
  });

  it("continues account startup when approval bootstrap startup fails", async () => {
    const channelRuntime = createRuntimeChannel();
    const stopped = createDeferred();
    const startAccount = vi.fn(
      async ({
        abortSignal,
      }: Parameters<NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>>[0]) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );
    hoisted.startChannelApprovalHandlerBootstrap.mockRejectedValue(new Error("boom"));

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, { channelRuntime });

    await manager.startChannels();

    expect(startAccount).toHaveBeenCalledTimes(1);
    const accountSnapshot =
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(accountSnapshot?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(accountSnapshot?.running).toBe(true);
    expect(accountSnapshot?.restartPending).toBe(false);
    expect(accountSnapshot?.lastError).toBeNull();

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await stopped.promise;
  });
});
