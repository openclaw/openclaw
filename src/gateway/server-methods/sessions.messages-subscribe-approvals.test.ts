import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("sessions.messages.subscribe approval opt-in", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
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
});
