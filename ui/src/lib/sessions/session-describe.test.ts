// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:describe-test";
const initial: GatewaySessionRow = { key, kind: "direct", sessionId: "first", updatedAt: 1 };

function harness() {
  let row = initial;
  const read = vi.fn(async () => ({ session: row }));
  const subscribe = vi.fn(async () => ({ subscribed: true }));
  const list = vi.fn(async () => sessionsResult([row], 1));
  const client = createTestGatewayClient(async (method) =>
    method === "sessions.describe" ? read() : method === "sessions.list" ? list() : subscribe(),
  );
  const gateway = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  return {
    ...gateway,
    client,
    sessions,
    read,
    subscribe,
    list,
    setRow: (next: GatewaySessionRow) => {
      row = next;
    },
  };
}

describe("session descriptor reads", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares concurrent identical reads and reuses the completed descriptor", async () => {
    const h = harness();
    const pending = createDeferred<{ session: GatewaySessionRow }>();
    h.read.mockReturnValueOnce(pending.promise);
    const reads = [h.sessions.describe({ key }), h.sessions.describe({ key })];
    expect(h.read).toHaveBeenCalledTimes(1);
    pending.resolve({ session: initial });
    expect(await Promise.all(reads)).toEqual([{ session: initial }, { session: initial }]);
    expect(await h.sessions.describe({ key })).toEqual({ session: initial });
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("keeps session, agent, preview parameters and request timeout distinct", async () => {
    const h = harness();
    for (const params of [
      { key },
      { key: "agent:main:other" },
      { key, agentId: "work" },
      { key, includeDerivedTitles: true },
      { key, includeLastMessage: true },
    ]) {
      await h.sessions.describe(params);
      await h.sessions.describe({ ...params });
    }
    await h.sessions.describe({ key }, { timeoutMs: 30_000 });
    expect(h.read).toHaveBeenCalledTimes(6);
  });

  it("preserves the runtime sample time when reusing a running descriptor", async () => {
    const h = harness();
    h.setRow({ ...initial, runtimeMs: 500, status: "running" });
    vi.setSystemTime(1_000);
    expect((await h.sessions.describe({ key })).session?.runtimeSampledAt).toBe(1_000);
    vi.setSystemTime(5_000);
    expect((await h.sessions.describe({ key })).session?.runtimeSampledAt).toBe(1_000);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("fetches after an observed revision changes and on explicit refresh", async () => {
    const h = harness();
    await h.sessions.refresh({ agentId: "main" });
    await h.sessions.describe({ key });
    const next = { ...initial, updatedAt: 2, label: "New revision" };
    h.setRow(next);
    h.sessions.captureReconcile()(next);
    expect(await h.sessions.describe({ key })).toEqual({ session: next });
    await h.sessions.describe({ key }, { refresh: true });
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it("invalidates on session events and never caches an older in-flight reply", async () => {
    const h = harness();
    const pending = createDeferred<{ session: GatewaySessionRow }>();
    h.read.mockReturnValueOnce(pending.promise);
    const old = h.sessions.describe({ key });
    const next = { ...initial, updatedAt: 2 };
    h.setRow(next);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { key, agentId: "main", reason: "patch", session: next },
    });
    expect(await h.sessions.describe({ key })).toEqual({ session: next });
    pending.resolve({ session: initial });
    await old;
    expect(await h.sessions.describe({ key })).toEqual({ session: next });
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it.each(["config.changed", "chat.metadata.changed"])(
    "fetches fresh descriptor facts after %s",
    async (event) => {
      const h = harness();
      await h.sessions.describe({ key });
      const next = { ...initial, contextTokens: 262_144 };
      h.setRow(next);
      h.emitEvent({ type: "event", event, payload: {} });
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      expect(h.read).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    (["pending", "completed"] as const).flatMap((phase) =>
      (["missing", "unrelated", "parent"] as const).flatMap((coverage) =>
        [key, "agent:research:parent"].map((parentKey) => ({ phase, coverage, parentKey })),
      ),
    ),
  )(
    "checks ancestor coverage before reusing a $phase $parentKey descriptor ($coverage)",
    async ({ phase, coverage, parentKey }) => {
      const h = harness();
      const parent = { ...initial, key: parentKey };
      h.setRow(parent);
      const pending = createDeferred<{ session: GatewaySessionRow }>();
      h.read.mockReturnValueOnce(pending.promise);
      const previous = h.sessions.describe({ key: parentKey });
      if (phase === "completed") {
        pending.resolve({ session: parent });
        await previous;
      }
      const next = { ...parent, updatedAt: 2, label: "Current ancestor" };
      h.setRow(next);
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          key: "agent:main:child",
          sessionId: "replacement-child",
          reason: "create",
          ...(coverage === "unrelated" ? {} : { parentSessionKey: parentKey }),
          ...(coverage === "missing"
            ? {}
            : { ancestorSessions: coverage === "parent" ? [next] : [] }),
        },
      });
      const current = h.sessions.describe({ key: parentKey });
      expect(h.read).toHaveBeenCalledTimes(coverage === "unrelated" ? 1 : 2);
      pending.resolve({ session: parent });
      expect(await current).toEqual({ session: coverage === "unrelated" ? parent : next });
      await previous;
      expect(await h.sessions.describe({ key: parentKey })).toEqual({
        session: coverage === "unrelated" ? parent : next,
      });
      expect(h.read).toHaveBeenCalledTimes(coverage === "unrelated" ? 1 : 2);
    },
  );

  it.each(["refresh", "first observed revision"])(
    "supersedes a pending read on %s",
    async (cause) => {
      const h = harness();
      const pending = createDeferred<{ session: GatewaySessionRow }>();
      h.read.mockReturnValueOnce(pending.promise);
      const old = h.sessions.describe({ key });
      const next = { ...initial, updatedAt: 2 };
      h.setRow(next);
      if (cause === "first observed revision") {
        await h.sessions.refresh({ agentId: "main" });
      }
      const fresh = h.sessions.describe({ key }, { refresh: cause === "refresh" });
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(await fresh).toEqual({ session: next });
      pending.resolve({ session: initial });
      await old;
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      expect(h.read).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retain descriptors read during an event-subscription outage", async () => {
    const h = harness();
    h.list.mockResolvedValue(sessionsResult([], 1));
    h.subscribe.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "observation offline",
        retryable: true,
      }),
    );
    h.publish(false);
    h.publish(true);
    await h.sessions.describe({ key });
    expect(h.sessions.state.error).toContain("observation offline");
    await h.sessions.describe({ key });
    h.setRow({ ...initial, updatedAt: 2 });
    await vi.runOnlyPendingTimersAsync();
    expect(h.sessions.state.error).toBeNull();
    expect((await h.sessions.describe({ key })).session?.updatedAt).toBe(2);
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it.each(["same client", "replacement client"])(
    "retires completed and pending reads on a %s epoch",
    async (kind) => {
      const h = harness();
      await h.sessions.describe({ key });
      const pending = createDeferred<{ session: GatewaySessionRow }>();
      h.read.mockReturnValueOnce(pending.promise);
      const old = h.sessions.describe({ key }, { refresh: true });
      const next = { ...initial, sessionId: "replacement", updatedAt: 2 };
      h.setRow(next);
      const replacementRead = vi.fn(async () => ({ session: next }));
      const client =
        kind === "same client"
          ? h.client
          : createTestGatewayClient(async (method) =>
              method === "sessions.describe"
                ? replacementRead()
                : method === "sessions.list"
                  ? sessionsResult([next], 2)
                  : { subscribed: true },
            );
      h.publish(false);
      h.publish(true, client);
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      pending.resolve({ session: initial });
      await old;
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      expect(h.read).toHaveBeenCalledTimes(kind === "same client" ? 3 : 2);
      expect(replacementRead).toHaveBeenCalledTimes(kind === "same client" ? 0 : 1);
    },
  );

  it("delivers failures to every reader and allows a later retry", async () => {
    const h = harness();
    const pending = createDeferred<{ session: GatewaySessionRow }>();
    h.read.mockReturnValueOnce(pending.promise);
    const first = h.sessions.describe({ key }).catch((error: unknown) => error);
    const second = h.sessions.describe({ key }).catch((error: unknown) => error);
    const error = new Error("describe failed");
    pending.reject(error);
    expect(await Promise.all([first, second])).toEqual([error, error]);
    expect(await h.sessions.describe({ key })).toEqual({ session: initial });
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("keeps fresh settlement on its captured client without populating the new connection", async () => {
    const h = harness();
    const replacement = createTestGatewayClient(async () => ({
      session: { ...initial, sessionId: "other" },
    }));
    h.publish(false);
    h.publish(true, replacement);
    await expect(h.sessions.describe({ key }, { client: h.client })).rejects.toThrow(
      "gateway not connected",
    );
    await h.sessions.describe({ key }, { refresh: true, client: h.client });
    await h.sessions.describe({ key }, { refresh: true, client: h.client });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect((await h.sessions.describe({ key })).session?.sessionId).toBe("other");
  });
});
