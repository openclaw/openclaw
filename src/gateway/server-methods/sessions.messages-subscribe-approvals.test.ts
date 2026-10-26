import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { SessionApprovalReplay } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

function createClient(scopes = ["operator.admin"], deviceId?: string): GatewayClient {
  return {
    ...sharingPolicyClient({ scopes, deviceId }),
    connId: "conn-approval-reviewer",
  };
}

function approvalReplay(sessionKey = "agent:main:child"): SessionApprovalReplay {
  return { sessionKey, updatedAtMs: 42, approvals: [], truncated: false };
}

function createContext(
  params: {
    replay?: SessionApprovalReplay;
    config?: OpenClawConfig;
    client?: GatewayClient;
  } = {},
) {
  const client = params.client ?? createClient();
  const registry = createSessionMessageSubscriberRegistry();
  const register = vi.fn((...args: Parameters<typeof registry.subscribe>) => {
    const rollback = registry.subscribe(...args);
    return rollback && Object.assign(vi.fn(rollback), { commit: rollback.commit });
  });
  const read = vi.fn(async () =>
    params.replay
      ? { replay: params.replay, isCurrent: (): boolean => true, release: vi.fn() }
      : undefined,
  );
  const context = {
    getRuntimeConfig: () => params.config ?? { agents: { entries: { main: {} } } },
    listSessionPendingApprovals: read,
    logGateway: { error: vi.fn() },
    subscribeSessionMessageEvents: register,
    unsubscribeSessionMessageEvents: registry.unsubscribe,
  } as unknown as GatewayRequestContext;
  return {
    client,
    registry,
    read,
    register,
    request: async (body: Record<string, unknown>, method = "sessions.messages.subscribe") => {
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
    },
  };
}

type Response = Awaited<ReturnType<ReturnType<typeof createContext>["request"]>>;

function expectSuccess(respond: Response, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectError(respond: Response, error: Record<string, unknown> = { code: "UNAVAILABLE" }) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

describe("sessions.messages.subscribe approval opt-in", () => {
  it("replaces narration through a configured main alias without changing approval delivery", async () => {
    const key = "agent:main:work";
    const replay = approvalReplay(key);
    const { registry, client, request } = createContext({
      config: { agents: { entries: { main: {} } }, session: { mainKey: "work" } },
      replay,
    });
    const body = { key: "main", includeApprovals: true };

    const narration = await request({ ...body, mode: "narration" });
    expectSuccess(narration, expect.any(Object));
    expect([...registry.getNarration(key)]).toEqual([client.connId]);

    const foreground = await request(body);
    expectSuccess(foreground, { subscribed: true, key, agentId: "main", approvalReplay: replay });
    expect([...registry.get(key)]).toEqual([client.connId]);
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([client.connId]);
  });

  it("retains the foreground global observer after narration rollback and release", async () => {
    const key = "agent:work:global";
    const { registry, client, request, read } = createContext({
      config: { session: { scope: "global" }, agents: { entries: { main: {}, work: {} } } },
      replay: approvalReplay(key),
    });
    const foreground = await request({ key, subscriptionId: "foreground" });
    expectSuccess(foreground, { subscribed: true, key, agentId: "work" });
    const observer = { key: "global", agentId: "work", subscriptionId: "narration" };
    const narrationOptions = { mode: "narration", includeApprovals: true };
    const narration = await request({ ...observer, ...narrationOptions });
    expectSuccess(narration, expect.objectContaining({ key: "global", agentId: "work" }));
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([client.connId]);

    read.mockRejectedValueOnce(new Error("replay failed"));
    expectError(await request({ key, subscriptionId: "failed", ...narrationOptions }));
    expect([...registry.getNarration(key)]).toEqual([]);

    expectSuccess(await request(observer, "sessions.messages.unsubscribe"), expect.any(Object));
    expect([...registry.get(key)]).toEqual([client.connId]);
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual([]);
  });

  it.each(["stale", "missing"])(
    "rolls back a %s replay without losing the prior subscription",
    async (snapshot) => {
      const replay = approvalReplay();
      const { client, registry, request, read, register } = createContext({
        client: createClient(["operator.approvals"], "phone"),
      });
      registry.subscribe(client.connId!, replay.sessionKey);
      const release = vi.fn();
      if (snapshot === "stale") {
        read.mockResolvedValueOnce({ replay, isCurrent: () => false, release });
      }

      const respond = await request({ key: "child", includeApprovals: true });
      expectError(respond);
      expect(respond).toHaveBeenCalledOnce();
      expect([...registry.get(replay.sessionKey)]).toEqual([client.connId]);
      expect([...registry.getApprovals(replay.sessionKey)]).toEqual([]);
      expect(release).toHaveBeenCalledTimes(snapshot === "stale" ? 1 : 0);
      expect(read).toHaveBeenCalledOnce();
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        read.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(register.mock.results[0]?.value).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["approval scope without a paired device", createClient(["operator.approvals"])],
    ["paired device without approval authority", createClient(["operator.read"], "phone")],
  ] as const)("rejects %s", async (_name, client) => {
    const { read, register, request } = createContext({ client });
    const respond = await request({ key: "agent:main:child", includeApprovals: true });

    expect(read).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expectError(respond, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("operator.approvals"),
    });
  });
});
