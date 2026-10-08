import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolClient,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolSocketHandlers,
} from "../../../packages/gateway-client/src/protocol-client.js";
import { GatewaySessionMessageSubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../../packages/gateway-client/src/timeouts.js";
import type { SessionApprovalReplay } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

function createClient(
  params: {
    scopes: string[];
    deviceId?: string;
  } = { scopes: ["operator.admin"] },
): GatewayClient {
  return {
    connId: "conn-approval-reviewer",
    connect: {
      client: { id: "approval-subscribe-test", displayName: "Approval Subscribe Test" },
      scopes: params.scopes,
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
  } as unknown as GatewayClient;
}

function approvalReplay(sessionKey = "agent:main:child"): SessionApprovalReplay {
  return { sessionKey, updatedAtMs: 42, approvals: [], truncated: false };
}

function createContext(params: {
  replay?: SessionApprovalReplay;
  globalScope?: boolean;
  mainKey?: string;
  agents?: OpenClawConfig["agents"];
}) {
  const rollbackSubscription = Object.assign(vi.fn(), { commit: vi.fn() });
  const subscribeSessionMessageEvents = vi.fn(() => rollbackSubscription);
  const listSessionPendingApprovals = vi.fn(async () => {
    return params.replay
      ? { replay: params.replay, isCurrent: (): boolean => true, release: vi.fn() }
      : undefined;
  });
  const context = {
    getRuntimeConfig: () => ({
      agents: params.agents ?? { entries: { main: {} } },
      ...(params.globalScope || params.mainKey
        ? {
            session: {
              ...(params.globalScope ? { scope: "global" as const } : {}),
              ...(params.mainKey ? { mainKey: params.mainKey } : {}),
            },
          }
        : {}),
    }),
    listSessionPendingApprovals,
    logGateway: { error: vi.fn() },
    subscribeSessionMessageEvents,
  } as unknown as GatewayRequestContext;
  return {
    context,
    listSessionPendingApprovals,
    rollbackSubscription,
    subscribeSessionMessageEvents,
  };
}

async function subscribe(
  context: GatewayRequestContext,
  body: Record<string, unknown>,
  client = createClient(),
  method = "sessions.messages.subscribe",
) {
  const respond = vi.fn();
  await expectDefined(
    sessionSubscriptionHandlers[method],
    `session subscription handler ${method}`,
  )({
    req: { id: "req-subscribe-approvals" } as never,
    params: body,
    respond,
    context,
    client,
    isWebchatConnect: () => false,
  } satisfies GatewayRequestHandlerOptions);
  return respond;
}

function createCommittedSubscriptionBoundary(holdApprovalUpgradeOnly = false) {
  const sessionKey = "agent:main:main";
  const registry = createSessionMessageSubscriberRegistry();
  const gatewayClient = createClient();
  const context = {
    ...createContext({ replay: approvalReplay(sessionKey) }).context,
    subscribeSessionMessageEvents: registry.subscribe,
    unsubscribeSessionMessageEvents: registry.unsubscribe,
  } as GatewayRequestContext;
  const delayedResponses: string[] = [];
  let nextRequestId = 0;
  let socketHandlers: GatewayProtocolSocketHandlers | undefined;
  const protocol = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      socketHandlers = handlers;
      return {
        isOpen: () => true,
        send: (raw) => {
          const request = JSON.parse(raw) as {
            id: string;
            method: string;
            params: Record<string, unknown>;
          };
          const handler = expectDefined(
            sessionSubscriptionHandlers[request.method],
            `session subscription boundary handler ${request.method}`,
          );
          void handler({
            req: { id: request.id } as never,
            params: request.params,
            context,
            client: gatewayClient,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              const response = JSON.stringify({
                type: "res",
                id: request.id,
                ok,
                payload,
                error,
              });
              if (
                request.method === "sessions.messages.subscribe" &&
                (!holdApprovalUpgradeOnly || request.params.includeApprovals === true)
              ) {
                delayedResponses.push(response);
                return;
              }
              handlers.message(response);
            },
          } satisfies GatewayRequestHandlerOptions);
        },
        close: (code, reason) => {
          registry.unsubscribeAll(gatewayClient.connId ?? "");
          handlers.close(code ?? 1000, reason ?? "stopped");
        },
      };
    },
    createRequestId: () => `subscription-${++nextRequestId}`,
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  protocol.start();
  return {
    coordinator: new GatewaySessionMessageSubscriptionCoordinator(protocol),
    gatewayClient,
    protocol,
    registry,
    sessionKey,
    deliverLateResponses() {
      for (const response of delayedResponses) {
        socketHandlers?.message(response);
      }
    },
  };
}

describe("sessions.messages.subscribe approval opt-in", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces narration through a configured main alias without changing approval delivery", async () => {
    const key = "agent:main:work";
    const registry = createSessionMessageSubscriberRegistry();
    const client = createClient();
    const replay = approvalReplay(key);
    const { context } = createContext({ mainKey: "work", replay });
    context.subscribeSessionMessageEvents = registry.subscribe;
    const body = { key: "main", includeApprovals: true };

    const narration = await subscribe(context, { ...body, mode: "narration" }, client);
    expect(narration).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect([...registry.getNarration(key)]).toEqual([client.connId]);

    const foreground = await subscribe(context, body, client);
    expect(foreground).toHaveBeenCalledWith(
      true,
      { subscribed: true, key, agentId: "main", approvalReplay: replay },
      undefined,
    );
    expect([...registry.get(key)]).toEqual([client.connId]);
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([client.connId]);
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
  });

  it("retains the foreground global observer after narration rollback and release", async () => {
    const key = "agent:work:global";
    const registry = createSessionMessageSubscriberRegistry();
    const client = createClient();
    const { context, listSessionPendingApprovals } = createContext({
      globalScope: true,
      agents: { entries: { main: {}, work: {} } },
      replay: approvalReplay(key),
    });
    context.subscribeSessionMessageEvents = registry.subscribe;
    context.unsubscribeSessionMessageEvents = registry.unsubscribe;
    const foreground = await subscribe(context, { key, subscriptionId: "foreground" }, client);
    expect(foreground).toHaveBeenCalledWith(
      true,
      { subscribed: true, key, agentId: "work" },
      undefined,
    );
    const narration = await subscribe(
      context,
      {
        key: "global",
        agentId: "work",
        subscriptionId: "narration",
        mode: "narration",
        includeApprovals: true,
      },
      client,
    );
    expect(narration).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ key: "global", agentId: "work" }),
      undefined,
    );
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([client.connId]);

    listSessionPendingApprovals.mockRejectedValueOnce(new Error("replay failed"));
    const failed = await subscribe(
      context,
      {
        key,
        subscriptionId: "failed",
        mode: "narration",
        includeApprovals: true,
      },
      client,
    );
    expect(failed).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect([...registry.getNarration(key)]).toEqual([]);

    const released = await subscribe(
      context,
      {
        key: "global",
        agentId: "work",
        subscriptionId: "narration",
      },
      client,
      "sessions.messages.unsubscribe",
    );
    expect(released).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect([...registry.get(key)]).toEqual([client.connId]);
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([]);
  });

  it("reprepares a stale replay before acknowledging a paired approval reviewer", async () => {
    const currentReplay = approvalReplay();
    const staleReplay = {
      ...currentReplay,
      updatedAtMs: 41,
      approvals: [
        {
          id: "terminal-before-ack",
          status: "pending",
          presentation: {
            kind: "exec",
            commandText: "printf old",
            allowedDecisions: ["allow-once", "deny"],
          },
          urlPath: "/approve/terminal-before-ack",
          createdAtMs: 1,
          expiresAtMs: 60_000,
        },
      ],
    } satisfies SessionApprovalReplay;
    const { context, listSessionPendingApprovals } = createContext({ replay: currentReplay });
    listSessionPendingApprovals.mockResolvedValueOnce({
      replay: staleReplay,
      isCurrent: () => false,
      release: vi.fn(),
    });

    const respond = await subscribe(
      context,
      { key: "child", includeApprovals: true },
      createClient({ scopes: ["operator.approvals"], deviceId: "phone" }),
    );

    expect(listSessionPendingApprovals).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        subscribed: true,
        key: currentReplay.sessionKey,
        agentId: "main",
        approvalReplay: currentReplay,
      },
      undefined,
    );
  });

  it("rolls back after one retry when replay keeps changing", async () => {
    const replay = approvalReplay();
    const { context, listSessionPendingApprovals, rollbackSubscription } = createContext({
      replay,
    });
    listSessionPendingApprovals
      .mockResolvedValueOnce({ replay, isCurrent: () => false, release: vi.fn() })
      .mockResolvedValueOnce({ replay, isCurrent: () => false, release: vi.fn() });

    const respond = await subscribe(context, { key: "child", includeApprovals: true });

    expect(listSessionPendingApprovals).toHaveBeenCalledTimes(2);
    expect(rollbackSubscription).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it.each([
    {
      name: "approval scope without a paired device",
      client: createClient({ scopes: ["operator.approvals"] }),
    },
    {
      name: "paired device without approval authority",
      client: createClient({ scopes: ["operator.read"], deviceId: "phone" }),
    },
  ])("rejects $name", async ({ client }) => {
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext(
      {},
    );
    const respond = await subscribe(
      context,
      { key: "agent:main:child", includeApprovals: true },
      client,
    );

    expect(listSessionPendingApprovals).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("operator.approvals"),
      }),
    );
  });

  it("restores the prior subscription when replay returns no snapshot", async () => {
    const {
      context,
      listSessionPendingApprovals,
      rollbackSubscription,
      subscribeSessionMessageEvents,
    } = createContext({});
    const respond = await subscribe(context, { key: "agent:main:child", includeApprovals: true });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-approval-reviewer",
      "agent:main:child",
      { includeApprovals: true, provisional: true },
    );
    expect(subscribeSessionMessageEvents.mock.invocationCallOrder[0]).toBeLessThan(
      listSessionPendingApprovals.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(rollbackSubscription).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("removes a committed approval observer when its subscription acknowledgment times out", async () => {
    vi.useFakeTimers();
    const boundary = createCommittedSubscriptionBoundary();
    let failure: unknown;
    void boundary.coordinator
      .acquire("main", { includeApprovals: true })
      .catch((error: unknown) => {
        failure = error;
      });

    expect(
      boundary.registry.get(boundary.sessionKey).has(boundary.gatewayClient.connId ?? ""),
    ).toBe(true);
    expect(
      boundary.registry.getApprovals(boundary.sessionKey).has(boundary.gatewayClient.connId ?? ""),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(boundary.registry.get(boundary.sessionKey)).toEqual(new Set());
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    boundary.deliverLateResponses();
    expect(boundary.registry.get(boundary.sessionKey)).toEqual(new Set());
    boundary.protocol.stop();
  });

  it("removes timed-out approval authority while preserving an existing plain observer", async () => {
    vi.useFakeTimers();
    const boundary = createCommittedSubscriptionBoundary(true);
    const plain = await boundary.coordinator.acquire("main");
    let failure: unknown;
    void boundary.coordinator
      .acquire("main", { includeApprovals: true })
      .catch((error: unknown) => {
        failure = error;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(
      new Set([boundary.gatewayClient.connId]),
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(boundary.registry.get(boundary.sessionKey)).toEqual(
      new Set([boundary.gatewayClient.connId]),
    );
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    boundary.deliverLateResponses();
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    await boundary.coordinator.release(plain);
    boundary.protocol.stop();
  });
});
