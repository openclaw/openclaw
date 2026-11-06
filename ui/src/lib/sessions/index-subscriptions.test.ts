// @vitest-environment node
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";
import {
  createSessionScopedOperations,
  preloadSessionMessageSubscriptions,
} from "./session-scoped-operations.ts";

const subscriptionRequestOptions = { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };
type Params = Record<string, unknown>;
type SubscribeOptions = NonNullable<Parameters<SessionCapability["subscribeMessages"]>[1]>;

function wireCall(action: "subscribe" | "unsubscribe", params: Record<string, unknown>) {
  return [
    `sessions.messages.${action}`,
    { ...params, subscriptionId: expect.any(String) },
    subscriptionRequestOptions,
  ];
}

function createGateway(request: (method: string, params?: Params) => Promise<unknown>) {
  return createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway;
}

function observerRequest(reply: (params?: Params) => unknown) {
  return vi.fn(async (method: string, params?: Params) => {
    if (method === "sessions.messages.subscribe") {
      return reply(params);
    }
    if (method === "sessions.messages.unsubscribe") {
      return {};
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}

describe("createSessionCapability message subscriptions", () => {
  it("retains the requested subscription intent while admission is pending", async () => {
    await preloadSessionMessageSubscriptions();
    const request = vi.fn(async (_method: string, params?: Params) => ({
      key: params?.key,
      agentId: params?.agentId,
    }));
    const sessions = createTestSessionCapability(createGateway(request));
    const intent = { agentId: "main", mode: "narration", includeApprovals: true } as const;
    const options: SubscribeOptions = { ...intent, agentId: " Main " };
    const pending = sessions.subscribeMessages("global", options);
    expect(request).toHaveBeenCalledOnce();
    Object.assign(options, { agentId: "work", mode: undefined, includeApprovals: false });
    const subscription = await pending;

    expect(request.mock.calls).toEqual([wireCall("subscribe", { key: "global", ...intent })]);
    await sessions.unsubscribeMessages(subscription);
  });

  it.each(["reconnect", "dispose"])(
    "retires a pending wire observer when %s interrupts admission",
    async (retirement) => {
      await preloadSessionMessageSubscriptions();
      const request = vi.fn(async (_method: string, params?: Params) => ({
        key: params?.key,
      }));
      const client = { request } as unknown as GatewayBrowserClient;
      const gateway = createGatewayHarness(client).gateway;
      let scope = { client, epoch: 0 };
      const operations = createSessionScopedOperations({
        gateway,
        connection: { capture: () => scope, isCurrent: (captured) => captured === scope },
        reconcileMutation: async () => ({ status: "stale" }),
      });
      const acquisition = operations.subscribeMessages("agent:main:old");
      expect(request.mock.calls).toEqual([wireCall("subscribe", { key: "agent:main:old" })]);
      if (retirement === "dispose") {
        operations.dispose();
      } else {
        scope = { client, epoch: 1 };
        operations.retireConnection(client);
      }
      await expect(acquisition).rejects.toThrow("replaced Gateway connection");
      if (retirement === "dispose") {
        expect(request.mock.calls.at(-1)).toEqual(
          wireCall("unsubscribe", { key: "agent:main:old" }),
        );
      }
      request.mockClear();
      if (retirement === "reconnect") {
        const current = await operations.subscribeMessages("agent:main:current");
        expect(request.mock.calls).toEqual([wireCall("subscribe", { key: "agent:main:current" })]);
        await operations.unsubscribeMessages(current);
      }
      operations.dispose();
    },
  );

  it.each(["accepted", "connect denied", "hello denied", "client replaced", "socket replaced"])(
    "pipelines selected history after connect dispatch and fences %s admission",
    async (admission) => {
      await preloadSessionMessageSubscriptions();
      const dispatch = createDeferred<boolean>();
      let connectSent = dispatch.promise;
      const sent = createDeferred();
      const initialHistory = { ok: true as const, payload: { messages: [] } };
      const response = createDeferred<{ key: string; initialHistory: typeof initialHistory }>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.messages.subscribe") {
          sent.resolve();
          return response.promise;
        }
        if (method === "sessions.messages.unsubscribe") {
          return {};
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = createTestGatewayClient(request);
      Object.defineProperty(client, "connectSent", { get: () => connectSent });
      const { gateway, publish } = createGatewayHarness(client, undefined, {
        initial: { phase: "reconnecting" },
      });
      const connection = createGatewayConnectionLifecycle(gateway.snapshot);
      const stopGateway = gateway.subscribe(connection.transition);
      const operations = createSessionScopedOperations({
        gateway,
        connection,
        reconcileMutation: async () => ({ status: "stale" }),
      });
      onTestFinished(() => {
        operations.dispose();
        stopGateway();
      });
      const key = "agent:main:selected";
      const options = { initialHistory: { limit: 80 } };
      const acquisition = operations.subscribeMessages(key, options, { beforeHello: true });
      const settled = acquisition.then(
        (subscription) => ({ subscription, error: null }),
        (error: unknown) => ({ subscription: null, error }),
      );
      const rejectedResult = {
        subscription: null,
        error: expect.objectContaining({
          message: expect.stringContaining("replaced Gateway connection"),
        }),
      };
      expect(request).not.toHaveBeenCalled();

      dispatch.resolve(admission !== "connect denied");
      if (admission === "connect denied") {
        expect(await settled).toEqual(rejectedResult);
        expect(request).not.toHaveBeenCalled();
        return;
      }
      await sent.promise;
      expect(gateway.snapshot.phase).toBe("reconnecting");
      expect(request.mock.calls).toEqual([wireCall("subscribe", { key, ...options })]);

      if (admission === "socket replaced") {
        connectSent = Promise.resolve(true);
      }
      if (admission !== "hello denied") {
        publish(true, admission === "client replaced" ? createTestGatewayClient(request) : client);
      }
      response.resolve({ key, initialHistory });
      const result = await settled;
      if (admission === "accepted") {
        expect(result).toEqual({
          subscription: { key, agentId: null, initialHistory },
          error: null,
        });
        if (result.subscription) {
          await operations.unsubscribeMessages(result.subscription);
        }
      } else {
        expect(result).toEqual(rejectedResult);
      }
      expect(request.mock.calls.at(-1)).toEqual(wireCall("unsubscribe", { key }));
    },
  );

  it("shares narration and foreground observers across capabilities without retiring the full stream", async () => {
    const request = observerRequest(() => ({ key: "agent:main:main" }));
    const gateway = createGateway(request);
    const first = createTestSessionCapability(gateway);
    const second = createTestSessionCapability(gateway);

    const [firstLease, secondLease] = await Promise.all([
      first.subscribeMessages("main", { mode: "narration" }),
      second.subscribeMessages("agent:main:main"),
    ]);

    expect(request.mock.calls).toEqual([
      wireCall("subscribe", { key: "main", mode: "narration" }),
      wireCall("subscribe", { key: "agent:main:main" }),
    ]);
    await first.unsubscribeMessages(firstLease);
    expect(request).toHaveBeenCalledTimes(2);
    await second.unsubscribeMessages(secondLease);
    expect(request.mock.calls.at(-1)).toEqual(wireCall("unsubscribe", { key: "agent:main:main" }));
  });

  it("upgrades a plain observer for approvals without downgrading existing owners", async () => {
    const replay = { approvals: [{ id: "approval-1" }] };
    const opts = { includeApprovals: true } as const;
    const request = observerRequest((params) => ({
      key: params?.key,
      ...(params?.includeApprovals ? { approvalReplay: replay } : {}),
    }));
    const sessions = createTestSessionCapability(createGateway(request));

    const plain = await sessions.subscribeMessages("main");
    const approval = await sessions.subscribeMessages("main", opts);
    const anotherPlain = await sessions.subscribeMessages("main");

    expect(approval).toEqual({ key: "main", agentId: null, ...opts, approvalReplay: replay });
    expect(request.mock.calls[1]).toEqual(wireCall("subscribe", { key: "main", ...opts }));
    await sessions.unsubscribeMessages(approval);
    await sessions.unsubscribeMessages(plain);
    expect(request).toHaveBeenCalledTimes(2);
    await sessions.unsubscribeMessages(anotherPlain);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["global", "qualified main alias"])(
    "retains each global observer owner through %s acknowledgment and release",
    async (keyForm) => {
      const observers = new Map<string, boolean>();
      const request = vi.fn(async (method: string, params?: Params) => {
        const key = params?.key;
        const agentId =
          params?.agentId ??
          (key === "agent:main:main" ? "main" : key === "agent:work:main" ? "work" : null);
        if (agentId !== "main" && agentId !== "work") {
          throw new Error("Canonical global observer requires its owner");
        }
        if (method === "sessions.messages.subscribe") {
          observers.set(agentId, params?.includeApprovals === true);
          return { key: "global" };
        }
        if (method === "sessions.messages.unsubscribe") {
          observers.delete(agentId);
          return {};
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const sessions = createTestSessionCapability(createGateway(request));

      const keyFor = (agentId: string) =>
        keyForm === "global" ? "global" : `agent:${agentId}:main`;
      const [main, work] = await Promise.all([
        sessions.subscribeMessages(keyFor("main"), { agentId: " Main " }),
        sessions.subscribeMessages(keyFor("work"), { agentId: " Work " }),
      ]);

      await sessions.unsubscribeMessages(main);
      expect([...observers]).toEqual([["work", false]]);
      const approval = await sessions.subscribeMessages(keyFor("work"), {
        agentId: "work",
        includeApprovals: true,
      });
      await sessions.unsubscribeMessages(work);
      expect([...observers]).toEqual([["work", true]]);
      await sessions.unsubscribeMessages(approval);
      expect(observers.size).toBe(0);
      expect([main, work]).toEqual(["main", "work"].map((agentId) => ({ key: "global", agentId })));
      expect(request.mock.calls.slice(0, 2)).toEqual([
        wireCall("subscribe", { key: keyFor("main"), agentId: "main" }),
        wireCall("subscribe", { key: keyFor("work"), agentId: "work" }),
      ]);
      expect(request.mock.calls.at(-1)).toEqual(
        wireCall("unsubscribe", { key: "global", agentId: "work" }),
      );
    },
  );
});
