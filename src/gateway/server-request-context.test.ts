import { describe, expect, it, vi } from "vitest";
import type { GatewayServerLiveState } from "./server-live-state.js";
import {
  createGatewayRequestContext,
  type GatewayRequestContextParams,
} from "./server-request-context.js";

function makeContextParams(
  overrides: Partial<GatewayRequestContextParams> = {},
): GatewayRequestContextParams {
  const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
    cronState: {
      cron: { start: vi.fn(), stop: vi.fn() } as never,
      storePath: "/tmp/cron",
      cronEnabled: true,
    },
  };
  return {
    deps: {} as never,
    runtimeState,
    execApprovalManager: undefined,
    pluginApprovalManager: undefined,
    loadGatewayModelCatalog: vi.fn(async () => []),
    getHealthCache: vi.fn(() => null),
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    logHealth: { error: vi.fn() },
    logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    incrementPresenceVersion: vi.fn(() => 1),
    getHealthVersion: vi.fn(() => 1),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    nodeSubscribe: vi.fn(),
    nodeUnsubscribe: vi.fn(),
    nodeUnsubscribeAll: vi.fn(),
    hasConnectedMobileNode: vi.fn(() => false),
    clients: new Set(),
    enforceSharedGatewayAuthGenerationForConfigWrite: vi.fn(),
    nodeRegistry: {} as never,
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    subscribeSessionEvents: vi.fn(),
    unsubscribeSessionEvents: vi.fn(),
    subscribeSessionMessageEvents: vi.fn(),
    unsubscribeSessionMessageEvents: vi.fn(),
    unsubscribeAllSessionEvents: vi.fn(),
    getSessionEventSubscriberConnIds: vi.fn(() => new Set<string>()),
    registerToolEventRecipient: vi.fn(),
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: vi.fn(() => null),
    purgeWizardSession: vi.fn(),
    getRuntimeSnapshot: vi.fn(() => ({}) as never),
    getRuntimeConfig: vi.fn(() => ({}) as never),
    startChannel: vi.fn(async () => undefined),
    stopChannel: vi.fn(async () => undefined),
    markChannelLoggedOut: vi.fn(),
    wizardRunner: vi.fn(async () => undefined),
    broadcastVoiceWakeChanged: vi.fn(),
    broadcastVoiceWakeRoutingChanged: vi.fn(),
    unavailableGatewayMethods: new Set(),
    ...overrides,
  };
}

describe("createGatewayRequestContext", () => {
  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
      cronState: {
        cron: cronA,
        storePath: "/tmp/cron-a",
        cronEnabled: true,
      },
    };

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = {
      cron: cronB,
      storePath: "/tmp/cron-b",
      cronEnabled: true,
    };

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });

  it("disconnectClientsForDevice logs close failures, falls back to terminate, and keeps evicting", () => {
    const warn = vi.fn();
    const closeError = Object.assign(new Error("socket already destroyed"), {
      code: "ERR_SOCKET_CLOSED",
    });

    const throwingSocket = {
      close: vi.fn(() => {
        throw closeError;
      }),
      terminate: vi.fn(),
    };
    const healthySocket = {
      close: vi.fn<(code: number, reason: string) => void>(),
      terminate: vi.fn<() => void>(),
    };
    const unrelatedSocket = {
      close: vi.fn<(code: number, reason: string) => void>(),
      terminate: vi.fn<() => void>(),
    };

    const clients = new Set([
      {
        connId: "conn-throws",
        connect: { device: { id: "device-1" }, role: "primary" },
        socket: throwingSocket,
      },
      {
        connId: "conn-healthy",
        connect: { device: { id: "device-1" }, role: "primary" },
        socket: healthySocket,
      },
      {
        connId: "conn-unrelated",
        connect: { device: { id: "device-2" }, role: "primary" },
        socket: unrelatedSocket,
      },
    ]) as unknown as GatewayRequestContextParams["clients"];

    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        logGateway: { warn, info: vi.fn(), error: vi.fn() } as never,
      }),
    );

    context.disconnectClientsForDevice!("device-1");

    expect(throwingSocket.close).toHaveBeenCalledWith(4001, "device removed");
    expect(throwingSocket.terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deviceId=device-1"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connId=conn-throws"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket already destroyed"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("attempting terminate()"));

    expect(healthySocket.close).toHaveBeenCalledWith(4001, "device removed");
    expect(healthySocket.terminate).not.toHaveBeenCalled();

    expect(unrelatedSocket.close).not.toHaveBeenCalled();
    expect(unrelatedSocket.terminate).not.toHaveBeenCalled();
  });
});
