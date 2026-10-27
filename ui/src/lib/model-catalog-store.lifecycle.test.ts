import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError as TimeoutError,
} from "@openclaw/gateway-client/browser";
import type { ErrorShape, ResponseFrame } from "@openclaw/gateway-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { clearModelCatalogCache, invalidateModelCatalogCache } from "./model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "./model-catalog-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:catalog" };
const stale = { models: [{ id: "stale", provider: "test", name: "Stale" }] };
const fresh = { models: [{ id: "fresh", provider: "test", name: "Fresh" }] };
const superseded = { code: "UNAVAILABLE", message: "Changed", retryable: true, retryAfterMs: 0 };

const agentStarting: ErrorShape = {
  ...superseded,
  details: { code: "agent-database-inspection-pending", agentId: "main" },
  retryAfterMs: 250,
};
const timeout = (timeoutMs: number) => ({ name: TimeoutError.name, timeoutMs, requestSent: true });

function protocolFixture(requestTimeoutMs?: number) {
  vi.useFakeTimers();
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const protocol = new GatewayPendingRequests({
    createRequestId: () => "catalog",
    nowMs: Date.now,
    requestTimeoutMs,
  });
  const client = createTestGatewayClient((method, params, options) =>
    protocol.request({ send: (frame) => sent.push(JSON.parse(frame)) }, method, params, options),
  );
  const reply = (index: number, response: Pick<ResponseFrame, "ok" | "payload" | "error">) => {
    const request = sent[index];
    if (!request) {
      throw new Error(`Missing catalog request ${index}`);
    }
    protocol.handleResponse({ type: "res", id: request.id, ...response });
  };
  const reads: Promise<ModelCatalogResult>[] = [];
  const clear = () => clearModelCatalogCache(client);
  onTestFinished(async () => {
    try {
      clear();
      protocol.flush(new Error("fixture closed"));
      await Promise.allSettled(reads);
    } finally {
      vi.useRealTimers();
    }
  });
  return {
    sent,
    read(options: Parameters<typeof loadModelCatalog>[1] = {}) {
      const result = loadModelCatalog(client, { ...scope, ...options });
      reads.push(result);
      return result;
    },
    peek: () => peekModelCatalog(client, scope),
    clear,
    invalidate: () => invalidateModelCatalogCache(client),
    respond(index: number, payload: ModelCatalogResult) {
      reply(index, { ok: true, payload });
    },
    fail(index: number, error: ErrorShape) {
      reply(index, { ok: false, error });
    },
    rejectTransport(error: Error) {
      protocol.flush(error);
    },
  };
}

it.each([
  { label: "non-retryable response", code: "UNAVAILABLE", retryable: false, correlated: true },
  { label: "forbidden response", code: "FORBIDDEN", retryable: true, correlated: true },
  { label: "local gateway-shaped error", code: "UNAVAILABLE", retryable: true, correlated: false },
])("does not retry a $label", async ({ code, retryable, correlated }) => {
  const fixture = protocolFixture();
  const result = fixture.read().catch((error: unknown) => error);
  const error = { ...superseded, code, retryable };
  if (correlated) {
    fixture.fail(0, error);
  } else {
    fixture.rejectTransport(new GatewayProtocolRequestError(error));
  }
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fixture.sent).toHaveLength(1);
  expect(await result).toMatchObject({ code, retryable, message: superseded.message });
  expect(fixture.peek()).toBeUndefined();
});

it("preserves inherited transport deadlines and explicit unbounded requests", async () => {
  const fixture = protocolFixture(25);
  const inherited = fixture.read();
  const unbounded = fixture.read({ timeoutMs: null });
  const expired = expect(inherited).rejects.toMatchObject(timeout(25));
  await vi.advanceTimersByTimeAsync(100);
  await expired;
  fixture.respond(1, fresh);
  expect(await unbounded).toEqual(fresh);
});

it("clears every live deadline and refresh shape across invalidation", async () => {
  const fixture = protocolFixture();
  const first = fixture.read();
  fixture.invalidate();
  const readers = [
    first,
    fixture.read(),
    fixture.read({ refresh: true }),
    fixture.read({ timeoutMs: null }),
    fixture.read({ timeoutMs: 100 }),
  ];
  const rejected = readers.map((reader) =>
    expect(reader).rejects.toHaveProperty("name", "AbortError"),
  );
  fixture.clear();
  await Promise.all(rejected);
  fixture.respond(0, stale);
  expect(fixture.sent).toHaveLength(4);
  expect(fixture.peek()).toBeUndefined();
});

it.each(["ready", "silent read", "failed", "disconnected"] as const)(
  "waits through prolonged agent startup, then handles %s",
  async (outcome) => {
    const fixture = protocolFixture();
    let settled = false;
    const result = fixture
      .read({ timeoutMs: 100 })
      .catch((error: unknown) => error)
      .finally(() => (settled = true));
    for (const [index, delay] of [500, 1_000, 2_000, 4_000, 5_000].entries()) {
      fixture.fail(index, agentStarting);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(settled).toBe(false);
      expect(fixture.sent).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(fixture.sent).toHaveLength(6);
    if (outcome === "ready") {
      fixture.respond(5, fresh);
      expect(await result).toEqual(fresh);
      expect(fixture.peek()).toEqual(fresh);
    } else if (outcome === "silent read") {
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject(timeout(100));
    } else if (outcome === "failed") {
      fixture.fail(5, {
        ...agentStarting,
        details: { code: "agent-database-inspection-failed", agentId: "main" },
        retryable: false,
      });
      expect(await result).toMatchObject({ retryable: false });
    } else {
      fixture.fail(5, agentStarting);
      await vi.advanceTimersByTimeAsync(0);
      fixture.clear();
      expect(await result).toHaveProperty("name", "AbortError");
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.sent).toHaveLength(6);
  },
);
