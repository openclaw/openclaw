import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "../../../src/gateway/events.js";
import { connectGateway } from "./app-gateway.ts";

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitClose: (code: number, reason?: string) => void;
  emitGap: (expected: number, received: number) => void;
  emitEvent: (evt: { event: string; payload?: unknown; seq?: number }) => void;
};

const gatewayClientInstances: GatewayClientMock[] = [];

vi.mock("./gateway.ts", () => {
  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(
      private opts: {
        onClose?: (info: { code: number; reason: string }) => void;
        onGap?: (info: { expected: number; received: number }) => void;
        onEvent?: (evt: { event: string; payload?: unknown; seq?: number }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        emitClose: (code, reason) => {
          this.opts.onClose?.({ code, reason: reason ?? "" });
        },
        emitGap: (expected, received) => {
          this.opts.onGap?.({ expected, received });
        },
        emitEvent: (evt) => {
          this.opts.onEvent?.(evt);
        },
      });
    }
  }

  return { GatewayBrowserClient };
});

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dark",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    password: "",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    sessionKey: "main",
    chatRunId: null,
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as Parameters<typeof connectGateway>[0];
}

describe("connectGateway", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
  });

  it("ignores stale client onGap callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitGap(10, 13);
    expect(host.lastError).toBeNull();

    secondClient.emitGap(20, 24);
    expect(host.lastError).toBe(
      "event gap detected (expected seq 20, got 24); refresh recommended",
    );
  });

  it("ignores stale client onEvent callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({ event: "presence", payload: { presence: [{ host: "stale" }] } });
    expect(host.eventLogBuffer).toHaveLength(0);

    secondClient.emitEvent({ event: "presence", payload: { presence: [{ host: "active" }] } });
    expect(host.eventLogBuffer).toHaveLength(1);
    expect(host.eventLogBuffer[0]?.event).toBe("presence");
  });

  it("applies update.available only from active client", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "9.9.9", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toBeNull();

    secondClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("ignores stale client onClose callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitClose(1005);
    expect(host.lastError).toBeNull();

    secondClient.emitClose(1005);
    expect(host.lastError).toBe("disconnected (1005): no reason");
  });
});
