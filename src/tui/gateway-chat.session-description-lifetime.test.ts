import { describe, expect, it, vi } from "vitest";
import {
  type HelloOk,
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { withGatewayChatConnection } from "./gateway-chat.test-support.js";
import type { TuiSessionDescription, TuiSessionList } from "./tui-backend.js";

const selectedKey = "agent:work:notes";
const oldDescription = {
  session: { key: selectedKey, sessionId: "old-session", model: "old-session-model" },
  defaults: { model: "old-default-model", contextTokens: 8192 },
} satisfies TuiSessionDescription;
const currentDescription = {
  session: { key: selectedKey, sessionId: "current-session", model: "current-session-model" },
  defaults: { model: "current-default-model", contextTokens: 32768 },
} satisfies TuiSessionDescription;
const oldListing: TuiSessionList = {
  ts: 1,
  path: "old-store",
  count: 0,
  sessions: [],
  defaults: oldDescription.defaults,
};
const currentListing: TuiSessionList = {
  ts: 2,
  path: "current-store",
  count: 0,
  sessions: [],
  defaults: currentDescription.defaults,
};

function hello(connId: string): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.9.4", connId },
    features: {
      methods: ["chat.history", "sessions.describe", "sessions.list"],
      events: [],
      capabilities: [],
    },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
  };
}

describe("GatewayChatClient session description lifetime", () => {
  it("stops a disconnected metadata retry without dispatching on a later connection", async () => {
    const entered = createDeferred();
    const held = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        entered.resolve();
        return held.promise;
      }
      return oldListing;
    });
    await withGatewayChatConnection(request, async (client, callbacks) => {
      callbacks.onHelloOk?.(hello("old"));
      const description = client.describeSession({ sessionKey: selectedKey });
      const rejected = expect(description).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      callbacks.onClose?.(1001, "reconnecting");
      held.resolve({ session: oldDescription.session });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await client.stop();
      await rejected;
      const completedCalls = request.mock.calls.length;
      callbacks.onHelloOk?.(hello("late"));
      expect(request).toHaveBeenCalledTimes(completedCalls);
      await expect(client.describeSession({ sessionKey: selectedKey })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(request).toHaveBeenCalledTimes(completedCalls);
    });
  });

  it.each([
    { heldMethod: "sessions.describe", reconnect: true, failure: true },
    { heldMethod: "sessions.list", reconnect: true, failure: false },
    { heldMethod: "sessions.describe", reconnect: false, failure: true },
    { heldMethod: "sessions.list", reconnect: false, failure: true },
  ])(
    "settles $heldMethod metadata (reconnect=$reconnect, failure=$failure)",
    async ({ heldMethod, reconnect, failure }) => {
      const entered = createDeferred();
      const held = createDeferred<unknown>();
      const error = new Error("Metadata request failed");
      let current = !reconnect;
      const response = (method: string) =>
        method === "sessions.describe"
          ? { session: (current ? currentDescription : oldDescription).session }
          : current
            ? currentListing
            : oldListing;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          expect(params).toEqual({ key: selectedKey, agentId: "work" });
        } else if (method === "sessions.list" && validateSessionsListParams(params)) {
          expect(params).toEqual({ agentId: "work", limit: 1 });
        } else {
          throw new Error(`Unexpected metadata request: ${method}`);
        }
        if (method === heldMethod && (!reconnect || !current)) {
          entered.resolve();
          return held.promise;
        }
        return response(method);
      });
      await withGatewayChatConnection(request, async (client, callbacks) => {
        callbacks.onHelloOk?.(hello(current ? "current" : "old"));
        const description = client.describeSession({ sessionKey: selectedKey, agentId: "work" });
        const settled = reconnect
          ? expect(description).resolves.toEqual(currentDescription)
          : expect(description).rejects.toBe(error);
        await entered.promise;
        const oldResponse = response(heldMethod);
        if (reconnect) {
          callbacks.onClose?.(1001, "reconnecting");
          current = true;
          callbacks.onHelloOk?.(hello("current"));
        }
        if (failure) {
          held.reject(error);
        } else {
          held.resolve(oldResponse);
        }
        await settled;
        if (!reconnect) {
          expect(request.mock.calls.filter(([method]) => method === heldMethod)).toHaveLength(1);
        }
      });
    },
  );
});
