import { describe, expect, it, vi } from "vitest";
import {
  type HelloOk,
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import type { GatewayChatClient } from "./gateway-chat.js";
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

async function withConnection(
  request: (method: string, params?: unknown) => Promise<unknown>,
  run: (client: GatewayChatClient, callbacks: GatewayClientOptions) => Promise<void>,
) {
  const transport: { options?: GatewayClientOptions } = {};
  let client: GatewayChatClient | undefined;
  vi.resetModules();
  vi.doMock("../gateway/client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../gateway/client.js")>();
    return {
      ...actual,
      GatewayClient: class {
        request = request;
        stopAndWait() {
          return Promise.resolve();
        }
        constructor(options: GatewayClientOptions) {
          transport.options = options;
        }
      },
    };
  });
  try {
    const { GatewayChatClient: Client } = await import("./gateway-chat.js");
    client = new Client({ url: "ws://127.0.0.1:18789", token: "test-token" });
    const callbacks = transport.options;
    if (!callbacks?.onHelloOk || !callbacks.onClose) {
      throw new Error("Gateway client did not register its connection lifecycle");
    }
    await run(client, callbacks);
  } finally {
    await client?.stop();
    vi.doUnmock("../gateway/client.js");
    vi.resetModules();
  }
}

const heldMethods: Array<"sessions.describe" | "sessions.list"> = [
  "sessions.describe",
  "sessions.list",
];

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
    await withConnection(request, async (client, callbacks) => {
      callbacks.onHelloOk?.(hello("old"));
      const description = client.describeSession({ sessionKey: selectedKey });
      const rejected = expect(description).rejects.toMatchObject({ name: "AbortError" });
      const settledDescription = Promise.allSettled([description, rejected]);
      try {
        await expect(
          Promise.race([
            entered.promise.then(() => "entered"),
            description.then(() => "completed"),
          ]),
        ).resolves.toBe("entered");
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
      } finally {
        held.resolve(undefined);
        await client.stop();
        await settledDescription;
      }
    });
  });

  describe.each(heldMethods)("pending %s", (heldMethod) => {
    it.each(["success", "failure"])(
      "discards old-connection %s and reloads both metadata sources",
      async (oldOutcome) => {
        const entered = createDeferred();
        const held = createDeferred<unknown>();
        let current = false;
        const request = vi.fn(async (method: string, params?: unknown) => {
          let response: unknown;
          if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
            expect(params).toEqual({ key: selectedKey, agentId: "work" });
            response = { session: (current ? currentDescription : oldDescription).session };
          } else if (method === "sessions.list" && validateSessionsListParams(params)) {
            expect(params).toEqual({ agentId: "work", limit: 1 });
            response = current ? currentListing : oldListing;
          } else {
            throw new Error(`Unexpected metadata request: ${method}`);
          }
          if (!current && method === heldMethod) {
            entered.resolve();
            return held.promise;
          }
          return response;
        });
        await withConnection(request, async (client, callbacks) => {
          callbacks.onHelloOk?.(hello("old"));
          const description = client.describeSession({
            sessionKey: selectedKey,
            agentId: "work",
          });
          const settledDescription = Promise.allSettled([description]);
          try {
            await expect(
              Promise.race([
                entered.promise.then(() => "entered"),
                description.then(() => "completed"),
              ]),
            ).resolves.toBe("entered");
            callbacks.onClose?.(1001, "reconnecting");
            current = true;
            callbacks.onHelloOk?.(hello("current"));
            if (oldOutcome === "failure") {
              held.reject(new Error("Old metadata request lost its connection"));
            } else {
              held.resolve(
                heldMethod === "sessions.describe"
                  ? { session: oldDescription.session }
                  : oldListing,
              );
            }

            await expect(description).resolves.toEqual(currentDescription);
          } finally {
            held.resolve(undefined);
            await client.stop();
            await settledDescription;
          }
        });
      },
    );

    it("propagates a current-connection error without retrying or returning partial metadata", async () => {
      const failure = new Error("Current metadata request failed");
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          expect(params).toEqual({ key: selectedKey, agentId: "work" });
        } else if (method === "sessions.list" && validateSessionsListParams(params)) {
          expect(params).toEqual({ agentId: "work", limit: 1 });
        } else {
          throw new Error(`Unexpected metadata request: ${method}`);
        }
        if (method === heldMethod) {
          throw failure;
        }
        return method === "sessions.describe"
          ? { session: currentDescription.session }
          : currentListing;
      });
      await withConnection(request, async (client, callbacks) => {
        callbacks.onHelloOk?.(hello("current"));

        await expect(
          client.describeSession({ sessionKey: selectedKey, agentId: "work" }),
        ).rejects.toBe(failure);
        expect(request.mock.calls.filter(([method]) => method === heldMethod)).toHaveLength(1);
      });
    });
  });
});
