import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import type { ErrorShape, ResponseFrame } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { clearModelCatalogCache, invalidateModelCatalogCache } from "./model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "./model-catalog-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:catalog" };
const stale = { models: [{ id: "stale", provider: "test", name: "Stale" }] };
const fresh = { models: [{ id: "fresh", provider: "test", name: "Fresh" }] };
const superseded: ErrorShape = {
  code: "UNAVAILABLE",
  message: "Session changed while preparing its model catalog.",
  retryable: true,
  retryAfterMs: 0,
};

const agentStarting: ErrorShape = {
  code: "UNAVAILABLE",
  message: "Agent main has not completed startup inspection and preparation.",
  details: { code: "agent-database-inspection-pending", agentId: "main" },
  retryable: true,
  retryAfterMs: 250,
};

afterEach(() => vi.useRealTimers());

function protocolFixture(requestTimeoutMs?: number) {
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
  return {
    client,
    sent,
    respond(index: number, payload: ModelCatalogResult) {
      reply(index, { ok: true, payload });
    },
    fail(index: number, error: ErrorShape) {
      reply(index, { ok: false, error });
    },
    rejectTransport(error: Error) {
      protocol.flush(error);
    },
    close() {
      clearModelCatalogCache(client);
      protocol.flush(new Error("fixture closed"));
    },
  };
}

it.each([
  { label: "non-retryable response", code: "UNAVAILABLE", retryable: false, correlated: true },
  { label: "forbidden response", code: "FORBIDDEN", retryable: true, correlated: true },
  { label: "local gateway-shaped error", code: "UNAVAILABLE", retryable: true, correlated: false },
])("does not retry a $label", async ({ code, retryable, correlated }) => {
  vi.useFakeTimers();
  const fixture = protocolFixture();
  const result = loadModelCatalog(fixture.client, scope).catch((error: unknown) => error);
  const error = { ...superseded, code, retryable };
  try {
    if (correlated) {
      fixture.fail(0, error);
    } else {
      fixture.rejectTransport(new GatewayProtocolRequestError(error));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.sent).toHaveLength(1);
    expect(await result).toMatchObject({ code, retryable, message: superseded.message });
    expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
  } finally {
    fixture.close();
    await result;
  }
});

it("preserves inherited transport deadlines and explicit unbounded requests", async () => {
  vi.useFakeTimers();
  const fixture = protocolFixture(25);
  const inherited = loadModelCatalog(fixture.client, scope);
  const unbounded = loadModelCatalog(fixture.client, { ...scope, timeoutMs: null });
  const expired = expect(inherited).rejects.toMatchObject({
    name: GatewayProtocolRequestTimeoutError.name,
    timeoutMs: 25,
    requestSent: true,
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    await expired;
    fixture.respond(1, fresh);
    expect(await unbounded).toEqual(fresh);
  } finally {
    fixture.close();
    await Promise.allSettled([inherited, unbounded]);
  }
});

it("rejects shared readers when their connection is cleared", async () => {
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, scope);
  invalidateModelCatalogCache(fixture.client);
  const queued = loadModelCatalog(fixture.client, scope);
  const rejected = expect(queued).rejects.toHaveProperty("name", "AbortError");
  const activeRejected = expect(first).rejects.toHaveProperty("name", "AbortError");
  try {
    clearModelCatalogCache(fixture.client);
    await rejected;
    fixture.respond(0, stale);
    await activeRejected;
    expect(fixture.sent).toHaveLength(1);
    expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued]);
  }
});

it.each(["ready", "silent read", "failed", "disconnected"] as const)(
  "waits through prolonged agent startup, then handles %s",
  async (outcome) => {
    vi.useFakeTimers();
    const fixture = protocolFixture();
    let settled = false;
    const result = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 })
      .catch((error: unknown) => error)
      .finally(() => (settled = true));
    try {
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
        expect(peekModelCatalog(fixture.client, scope)).toEqual(fresh);
      } else if (outcome === "silent read") {
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({
          name: GatewayProtocolRequestTimeoutError.name,
          timeoutMs: 100,
          requestSent: true,
        });
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
        clearModelCatalogCache(fixture.client);
        expect(await result).toHaveProperty("name", "AbortError");
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.sent).toHaveLength(6);
    } finally {
      fixture.close();
      await result;
    }
  },
);
