/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { createContext, createGatewayHarness } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { observePersonActivityData } from "./person-activity-data.ts";

function fixture() {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  const sessions = createTestSessionCapability(gateway.gateway);
  const context = createContext(gateway.gateway, sessions);
  const refresh = createDeferred();
  const dispose = vi.fn();
  let publish!: (snapshot: SessionListSnapshot) => void;
  const stale = sessionsResult([{ key: "agent:old:stale", kind: "direct" }], 1);
  const observe = vi.spyOn(sessions, "observeList").mockImplementation((_query, listener) => {
    publish = listener;
    listener({ result: stale, agentId: null, loading: false, error: null, readSucceeded: true });
    return { refresh: () => refresh.promise, dispose };
  });
  const changed = vi.fn();
  const activity = observePersonActivityData(context, changed);
  return {
    gateway,
    refresh,
    dispose,
    observe,
    changed,
    activity,
    publish: (result: SessionListSnapshot) => publish({ readSucceeded: true, ...result }),
  };
}

it("admits only a refreshed cross-agent roster, retains rows on read failure, and applies removal", async () => {
  const f = fixture();
  const query = f.observe.mock.calls[0]![0];
  expect(query).toMatchObject({ limit: 200, rowMode: "compact", includeDerivedTitles: true });
  for (const key of ["agentId", "ownerId", "involvingMe", "search", "archivedFilter"]) {
    expect(query).not.toHaveProperty(key);
  }
  expect(f.activity.data?.sessionsResult).toBeNull();
  const result = sessionsResult([{ key: "agent:research:recent", kind: "direct" }], 2);
  f.publish({ result, agentId: null, loading: false, error: null });
  expect(f.activity.data?.sessionsResult).toBeNull();
  f.refresh.resolve();
  await f.refresh.promise;
  expect(f.activity.data?.sessionsResult).toBe(result);
  f.publish({ result: null, agentId: null, loading: false, error: "Temporarily unavailable" });
  expect(f.activity.data?.sessionsResult).toBe(result);
  const empty = sessionsResult([], 3);
  f.publish({ result: empty, agentId: null, loading: false, error: null });
  expect(f.activity.data?.sessionsResult).toBe(empty);
  f.activity.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it("does not admit a retained roster after a rejected opening read and recovers on fresh data", async () => {
  const f = fixture();
  f.refresh.reject(new Error("Unavailable"));
  await f.refresh.promise.catch(() => undefined);
  expect(f.activity.data?.sessionsResult).toBeNull();
  const fresh = sessionsResult([{ key: "agent:main:fresh", kind: "direct" }], 3);
  f.publish({ result: fresh, agentId: null, loading: false, error: null });
  expect(f.activity.data?.sessionsResult).toBe(fresh);
  f.activity.dispose();
});

it.each(["close", "connection"] as const)(
  "ignores late data after %s retires the card",
  async (retire) => {
    const f = fixture();
    if (retire === "close") {
      f.activity.dispose();
    } else {
      f.gateway.publish({ phase: "reconnecting" });
    }
    f.publish({
      result: sessionsResult([{ key: "agent:main:late", kind: "direct" }], 2),
      agentId: null,
      loading: false,
      error: null,
    });
    f.refresh.resolve();
    await f.refresh.promise;
    expect(f.activity.data).toBeUndefined();
    expect(f.changed).not.toHaveBeenCalled();
    if (retire === "connection") {
      f.activity.dispose();
    }
  },
);

it.each(["gateway-suspending", "agent-database-inspection-pending"])(
  "waits for fresh membership when the managed owner suppresses %s",
  async (reason) => {
    vi.useFakeTimers();
    let phase = "initial";
    const gateway = createGatewayHarness(
      createTestGatewayClient(async (method) => {
        if (method !== "sessions.list") {
          return {};
        }
        if (phase === "unavailable") {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Temporarily unavailable",
            retryable: true,
            retryAfterMs: 7_000,
            details:
              reason === "gateway-suspending"
                ? { reason, phase: "draining" }
                : { code: reason, agentId: "main" },
          });
        }
        return sessionsResult(
          [{ key: "agent:main:" + phase, kind: "direct" }],
          phase === "initial" ? 1 : 2,
        );
      }),
    );
    const sessions = createTestSessionCapability(gateway.gateway);
    const context = createContext(gateway.gateway, sessions);
    const observeList = sessions.observeList;
    let query: ReturnType<typeof observeList> | undefined;
    vi.spyOn(sessions, "observeList").mockImplementation((options, listener) => {
      query = observeList(options, listener);
      return query;
    });
    const loaded = createDeferred();
    const first = observePersonActivityData(context, () => loaded.resolve());
    await loaded.promise;
    expect(first.data?.sessionsResult?.sessions[0]?.key).toBe("agent:main:initial");
    phase = "unavailable";
    const settled = createDeferred();
    const reopened = observePersonActivityData(context, () => settled.resolve());
    try {
      await settled.promise;
      expect(reopened.data?.sessionsResult).toBeNull();
      phase = "recovered";
      await query?.refresh();
      expect(reopened.data?.sessionsResult?.sessions[0]?.key).toBe("agent:main:recovered");
    } finally {
      first.dispose();
      reopened.dispose();
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
