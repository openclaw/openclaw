// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:describe-test";
const initial: GatewaySessionRow = { key, kind: "direct", sessionId: "first", updatedAt: 1 };

function backend(row: () => GatewaySessionRow, ts = 1) {
  const read = vi.fn(async () => ({ session: row() }));
  const subscribe = vi.fn(async () => ({ subscribed: true }));
  const list = vi.fn(async () => sessionsResult([row()], ts));
  const client = createTestGatewayClient(async (method) =>
    method === "sessions.describe" ? read() : method === "sessions.list" ? list() : subscribe(),
  );
  return { read, subscribe, list, client };
}

function harness() {
  let row = initial;
  const api = backend(() => row);
  const gateway = createGatewayHarness(api.client);
  const sessions = createTestSessionCapability(gateway.gateway);
  return {
    ...gateway,
    ...api,
    sessions,
    pending: () => {
      const deferred = createDeferred<{ session: GatewaySessionRow }>();
      api.read.mockReturnValueOnce(deferred.promise);
      return deferred;
    },
    setRow: (next: GatewaySessionRow) => {
      row = next;
    },
    event: (event: string, payload: unknown) =>
      gateway.emitEvent({ type: "event", event, payload }),
  };
}

describe("session descriptor reads", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    vi.useFakeTimers();
    h = harness();
  });
  afterEach(() => vi.useRealTimers());

  it("reuses concurrent implied-agent descriptors and their runtime sample, isolating other agents", async () => {
    const running: GatewaySessionRow = { ...initial, runtimeMs: 500, status: "running" };
    h.setRow(running);
    vi.setSystemTime(1_000);
    const pending = h.pending();
    const reads = [
      h.sessions.describe({ key }),
      h.sessions.describe({ key }),
      h.sessions.describe({ key, agentId: "main" }),
      h.sessions.describe({ key, agentId: " MAIN " }),
    ];
    expect(h.read).toHaveBeenCalledTimes(1);
    const other = { ...initial, sessionId: "other-agent" };
    h.read.mockResolvedValueOnce({ session: other });
    expect(await h.sessions.describe({ key, agentId: "other" })).toEqual({ session: other });
    pending.resolve({ session: running });
    const sampled = { session: { ...running, runtimeSampledAt: 1_000 } };
    expect(await Promise.all(reads)).toEqual([sampled, sampled, sampled, sampled]);
    vi.setSystemTime(5_000);
    expect(await h.sessions.describe({ key })).toEqual(sampled);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("keeps session, agent, preview parameters and request timeout distinct", async () => {
    for (const params of [
      { key },
      { key: "agent:main:other" },
      { key, agentId: "work" },
      { key: "global" },
      { key: "global", agentId: "main" },
      { key, includeDerivedTitles: true },
      { key, includeLastMessage: true },
    ]) {
      await h.sessions.describe(params);
      await h.sessions.describe({ ...params });
    }
    await h.sessions.describe({ key }, { timeoutMs: 30_000 });
    expect(h.read).toHaveBeenCalledTimes(8);
  });

  it.each(["done", "running"] as const)(
    "resamples unchanged accumulated runtime when a %s session starts another run",
    async (status) => {
      const previous: GatewaySessionRow = {
        ...initial,
        status,
        lastRunId: "old-run",
        runtimeMs: 500,
      };
      vi.setSystemTime(1_000);
      h.setRow(previous);
      await h.sessions.describe({ key });
      vi.setSystemTime(10_000);
      const running: GatewaySessionRow = {
        ...previous,
        updatedAt: 2,
        status: "running",
        lastRunId: "new-run",
        activeRunIds: ["new-run"],
      };
      h.event("sessions.changed", { session: running, ancestorSessions: [] });
      expect((await h.sessions.describe({ key })).session?.runtimeSampledAt).toBe(10_000);
      vi.setSystemTime(20_000);
      h.event("sessions.changed", {
        session: { ...running, updatedAt: 3, activeRunIds: ["new-run"], label: "Renamed" },
        ancestorSessions: [],
      });
      expect((await h.sessions.describe({ key })).session?.runtimeSampledAt).toBe(10_000);
      expect(h.read).toHaveBeenCalledTimes(1);
    },
  );

  it("reuses a descriptor across unchanged row observations without a time limit", async () => {
    const first = { ...initial, snapshotAt: 1 };
    h.setRow(first);
    await h.sessions.refresh({ agentId: "main" });
    const described = await h.sessions.describe({ key });
    for (let step = 1; step <= 12; step += 1) {
      await vi.advanceTimersByTimeAsync(31_000);
      const observed = { ...first, snapshotAt: step + 1 };
      h.setRow(observed);
      await h.sessions.refresh({ agentId: "main", force: true });
      expect(h.sessions.state.result?.sessions[0]?.snapshotAt).toBe(step + 1);
      await h.sessions.describe({ key });
    }
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(await h.sessions.describe({ key })).toEqual(described);
  });

  it.each([false, true])(
    "reuses full event snapshots with previews=%s when reopening details",
    async (previews) => {
      const params = { key, includeDerivedTitles: previews, includeLastMessage: previews };
      h.setRow({ ...initial, label: "Original", contextTokens: 32_768 });
      await h.sessions.describe(params);
      for (let revision = 2; revision <= 12; revision++) {
        vi.setSystemTime(revision * 1_000);
        const next = {
          ...initial,
          updatedAt: revision,
          contextTokens: 65_536,
          totalTokens: revision,
          runtimeMs: revision * 100,
        };
        h.setRow(next);
        const enrichment =
          revision % 2 === 0
            ? {
                derivedTitle: "Current title",
                lastMessagePreview: "Current message",
                lastAssistantMessage: "Current reply",
              }
            : {};
        h.event(revision % 2 ? "session.message" : "sessions.changed", {
          agentId: "main",
          reason: "patch",
          session: { ...next, ...enrichment },
          ancestorSessions: [],
        });
        expect(await h.sessions.describe(params)).toEqual({
          session: {
            ...next,
            runtimeSampledAt: revision * 1_000,
            ...(previews ? enrichment : {}),
          },
        });
      }
      expect(h.read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { cause: "observed revision", phase: "completed", coverage: null },
    { cause: "sessions.changed", phase: "pending", coverage: null },
    { cause: "sessions.changed", phase: "completed", coverage: null },
    { cause: "compact row", phase: "completed", coverage: null },
    { cause: "replacement", phase: "completed", coverage: null },
    { cause: "config.changed", phase: "completed", coverage: null },
    { cause: "chat.metadata.changed", phase: "completed", coverage: null },
    { cause: "refresh", phase: "pending", coverage: null },
    { cause: "first observed revision", phase: "pending", coverage: null },
    ...(["pending", "completed"] as const).flatMap((phase) =>
      (["missing", "unrelated", "parent"] as const).map((coverage) => ({
        cause: "ancestor",
        phase,
        coverage,
      })),
    ),
  ] as const)(
    "refreshes a $phase descriptor after $cause ($coverage)",
    async ({ cause, phase, coverage }) => {
      const parentKey = coverage && phase === "completed" ? "agent:research:parent" : key;
      const parent = { ...initial, key: parentKey };
      h.setRow(parent);
      if (cause === "observed revision") {
        await h.sessions.refresh({ agentId: "main" });
      }
      const pending = h.pending();
      const old = h.sessions.describe({ key: parentKey });
      if (phase === "completed") {
        pending.resolve({ session: parent });
        await old;
      }
      const metadata = cause === "config.changed" || cause === "chat.metadata.changed";
      const next = metadata
        ? { ...parent, contextTokens: 262_144 }
        : {
            ...parent,
            ...(cause === "replacement" ? { sessionId: "replacement" } : {}),
            updatedAt: 2,
            label: "New revision",
          };
      h.setRow(next);
      if (coverage) {
        h.event("sessions.changed", {
          key: "agent:main:child",
          sessionId: "replacement-child",
          reason: "create",
          ...(coverage === "unrelated" ? {} : { parentSessionKey: parentKey }),
          ...(coverage === "missing"
            ? {}
            : { ancestorSessions: coverage === "parent" ? [next] : [] }),
        });
      } else if (cause === "observed revision") {
        h.sessions.captureReconcile()(next);
      } else if (cause === "first observed revision") {
        await h.sessions.refresh({ agentId: "main" });
      } else if (cause === "sessions.changed") {
        h.event(cause, { key, agentId: "main", reason: "patch", session: next });
      } else if (cause === "compact row" || cause === "replacement") {
        h.event("sessions.changed", {
          agentId: "main",
          reason: "patch",
          session: { ...next, ...(cause === "compact row" ? { rowMode: "compact" } : {}) },
          ancestorSessions: [],
        });
      } else if (metadata) {
        h.event(cause, {});
      }
      const fresh = h.sessions.describe({ key: parentKey }, { refresh: cause === "refresh" });
      const calls =
        coverage === "unrelated" || (coverage === "parent" && phase === "completed") ? 1 : 2;
      const expected = { session: coverage === "unrelated" ? parent : next };
      expect(h.read).toHaveBeenCalledTimes(calls);
      // Unrelated pending reads still wait for their original response.
      if (coverage) {
        pending.resolve({ session: parent });
      }
      expect(await fresh).toEqual(expected);
      pending.resolve({ session: parent });
      await old;
      expect(await h.sessions.describe({ key: parentKey })).toEqual(expected);
      expect(h.read).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(["pending", "completed"] as const)(
    "reuses a %s parent descriptor across unchanged ancestor references",
    async (phase) => {
      const parent = { ...initial, lifecycleRevision: "first-life" };
      h.setRow(parent);
      const child = {
        key: "agent:main:subagent:worker",
        kind: "direct" as const,
        sessionId: "child",
        spawnedBy: key,
      };
      const emit = (snapshotAt: number, changed = false) =>
        h.event(snapshotAt % 2 ? "sessions.changed" : "session.message", {
          agentId: "main",
          reason: "send",
          session: { ...child, updatedAt: snapshotAt, snapshotAt },
          ancestorSessions: changed
            ? [{ ...parent, snapshotAt, ancestorRevision: "parent-content" }]
            : [],
          ...(changed
            ? {}
            : {
                ancestorSessionRefs: [
                  { key, sessionId: parent.sessionId, revision: "parent-content", snapshotAt },
                ],
              }),
        });
      emit(2, true);
      const pending = h.pending();
      const first = h.sessions.describe({ key });
      if (phase === "completed") {
        pending.resolve({ session: parent });
        await first;
      }
      const readers = [first];
      for (let update = 3; update < 19; update++) {
        emit(update);
        readers.push(h.sessions.describe({ key }));
      }
      pending.resolve({ session: parent });
      expect(await Promise.all(readers)).toEqual(readers.map(() => ({ session: parent })));
      expect(h.read).toHaveBeenCalledTimes(1);
      emit(19, true);
      await h.sessions.describe({ key });
      expect(h.read).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retain descriptors read during an event-subscription outage", async () => {
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
      await h.sessions.describe({ key });
      const pending = h.pending();
      const old = h.sessions.describe({ key }, { refresh: true });
      const next = { ...initial, sessionId: "replacement", updatedAt: 2 };
      h.setRow(next);
      const replacement = backend(() => next, 2);
      h.publish(false);
      h.publish(true, kind === "same client" ? h.client : replacement.client);
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      pending.resolve({ session: initial });
      await old;
      expect(await h.sessions.describe({ key })).toEqual({ session: next });
      expect(h.read).toHaveBeenCalledTimes(kind === "same client" ? 3 : 2);
      expect(replacement.read).toHaveBeenCalledTimes(kind === "same client" ? 0 : 1);
    },
  );

  it("delivers failures to every reader and allows a later retry", async () => {
    const pending = h.pending();
    const first = h.sessions.describe({ key }).catch((error: unknown) => error);
    const second = h.sessions.describe({ key }).catch((error: unknown) => error);
    const error = new Error("describe failed");
    pending.reject(error);
    expect(await Promise.all([first, second])).toEqual([error, error]);
    expect(await h.sessions.describe({ key })).toEqual({ session: initial });
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("keeps fresh settlement on its captured client without populating the new connection", async () => {
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
