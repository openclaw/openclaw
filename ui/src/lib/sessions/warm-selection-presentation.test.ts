// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import * as reconciliation from "./reconcile.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");
const cleanup: Array<() => void> = [];
const pendingDeletes: Promise<unknown>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).toReversed()) {
      dispose();
    }
    await Promise.all(pendingDeletes.splice(0));
  } finally {
    vi.useRealTimers();
  }
});
const mainQuery = {
  agentId: "main",
  rowMode: "sidebar" as const,
  includeDerivedTitles: true,
  includeLastMessage: true,
  force: true,
};

// Hold the returning agent's RPC so assertions cannot pass through network revalidation.
async function createWarmSelectionHarness(holdObserver = false) {
  const pending = createDeferred<SessionsListResult>();
  const heldMainReadStarted = createDeferred();
  const observer = createDeferred<{ subscribed: boolean }>();
  let holdMain = false;
  let selectedId = "main";
  let intentRevision = 0;
  const listeners = new Set<() => void>();
  const result = (agentId: string) =>
    sessionsResult(
      [
        {
          key: `agent:${agentId}:main`,
          agentId,
          sessionId: `${agentId}-incarnation`,
          kind: "direct",
          updatedAt: 1,
        },
      ],
      1,
    );
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.subscribe") {
      return holdObserver ? observer.promise : { subscribed: true };
    }
    if (method === "sessions.delete") {
      return { deleted: true };
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    const agentId = requireRecord(params, "sessions.list params").agentId;
    if (typeof agentId !== "string") {
      throw new Error("Session query has no agent owner");
    }
    if (holdMain && agentId === "main") {
      heldMainReadStarted.resolve();
      return pending.promise;
    }
    return result(agentId);
  });
  const client = createTestGatewayClient(request);
  const harness = createGatewayHarness(client);
  const selection = {
    get state() {
      return { selectedId };
    },
    get intentRevision() {
      return intentRevision;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const sessions = createSessionCapability(harness.gateway, selection);
  cleanup.push(() => {
    pending.resolve(result("main"));
    sessions.dispose();
  });
  harness.publish(true);
  await vi.advanceTimersByTimeAsync(0);
  return {
    ...harness,
    sessions,
    request,
    heldMainReadStarted: heldMainReadStarted.promise,
    refuseObserver: () => observer.resolve({ subscribed: false }),
    result,
    select(agentId: string) {
      selectedId = agentId;
      intentRevision++;
      listeners.forEach((listener) => listener());
    },
    holdMain() {
      holdMain = true;
    },
  };
}

it.each([
  "none",
  "config",
  "reconnect",
  "profile",
  "local-patch",
  "local-delete",
  "query",
  "replacement-client",
  "observer",
  "observed-membership",
  "invalidated-read",
] as const)(
  "reuses only a live matching primary window across selection: %s",
  async (retirement) => {
    const h = await createWarmSelectionHarness(retirement === "observer");
    expect(h.sessions.state.result).toEqual(h.result("main"));
    if (retirement === "observed-membership") {
      const query = { ...mainQuery, limit: 50 };
      await h.sessions.refresh(query);
      const observed = h.sessions.observeList(query, () => undefined);
      cleanup.push(() => observed.dispose());
      await vi.advanceTimersByTimeAsync(0);
      h.request.mockResolvedValueOnce(
        sessionsResult(
          [
            ...h.result("main").sessions,
            { key: "agent:main:new", agentId: "main", kind: "direct", updatedAt: 2 },
          ],
          2,
        ),
      );
      await h.sessions.refresh(query);
      expect(h.sessions.state.result?.sessions).toHaveLength(2);
    } else if (retirement === "invalidated-read") {
      const stale = createDeferred<SessionsListResult>();
      cleanup.push(() => stale.resolve(h.result("main")));
      h.request.mockImplementationOnce(() => stale.promise);
      const refresh = h.sessions.refresh({ agentId: "main", force: true });
      h.emitEvent({ type: "event", event: "config.changed", payload: {} });
      stale.resolve(h.result("main"));
      await refresh;
      // Navigate before the scheduled corrective read can repair the old agent.
    }
    h.select("writer");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions.state.agentId).toBe("writer");
    h.holdMain();
    if (retirement === "config") {
      h.emitEvent({ type: "event", event: "config.changed", payload: {} });
    } else if (retirement === "reconnect") {
      h.publish(false);
      h.publish(true);
    } else if (retirement === "replacement-client") {
      h.publish(true, createTestGatewayClient(h.request));
    } else if (retirement === "observer") {
      h.refuseObserver();
      await vi.advanceTimersByTimeAsync(0);
    } else if (retirement === "profile") {
      h.gateway.snapshot.selfUser = { id: "another-profile" };
      h.publish(true);
    } else if (retirement === "local-patch") {
      h.sessions.patchRowLocal("agent:writer:main", { pinned: true });
    } else if (retirement === "local-delete") {
      pendingDeletes.push(
        h.sessions.delete("agent:main:main", {
          agentId: "main",
          expectedSessionId: "main-incarnation",
        }),
      );
      // The delete promise waits on this held read; its start proves confirmation.
      await h.heldMainReadStarted;
      expect(h.sessions.deletionState("agent:main:main", "main", "main-incarnation")).toBe(
        "confirmed",
      );
    } else if (retirement === "query") {
      await h.sessions.refresh({ agentId: "writer", ownerId: "another-owner", force: true });
    }
    h.select("main");
    expect(h.sessions.presentation.result).toEqual(retirement === "none" ? h.result("main") : null);
    await vi.advanceTimersByTimeAsync(0);
    if (retirement !== "observed-membership" && retirement !== "invalidated-read") {
      expect(
        h.request.mock.calls.filter(
          ([method, params]) =>
            method === "sessions.list" &&
            requireRecord(params, "sessions.list params").agentId === "main",
        ),
      ).toHaveLength(retirement === "local-delete" ? 3 : 2);
    }
    expect(h.sessions.state.agentId).not.toBe("main");
  },
);

it.each([
  [20, 1],
  [200, 1],
  [200, 8],
] as const)(
  "retains one updated window for return navigation (%i rows, %i events)",
  async (size, events) => {
    const h = await createWarmSelectionHarness();
    const rows = [
      { ...h.result("main").sessions[0]!, updatedAt: size + 2 },
      ...Array.from({ length: size - 1 }, (_, i) => ({
        key: `agent:main:work-${i}`,
        sessionId: `work-${i}`,
        kind: "direct" as const,
        updatedAt: size - i + 1,
        agentId: "main",
      })),
    ];
    h.request.mockResolvedValueOnce(sessionsResult(rows));
    await h.sessions.refresh({ ...mainQuery, limit: size });
    h.request.mockClear();
    const project = vi.spyOn(reconciliation, "projectSessionResultRows");
    const before = h.sessions.state.result!;
    const foreground = before.sessions[0];
    expect(foreground?.key).toBe(h.gateway.snapshot.sessionKey);
    for (const target of [{ ...rows[1]!, key: "agent:other:work-0", agentId: "other" }, rows[1]!]) {
      project.mockClear();
      for (let i = 0; i < events; i++) {
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            reason: "patch",
            agentId: target.agentId,
            session: { ...target, label: `Live ${i}`, updatedAt: size + 10 + i },
            ancestorSessions: [],
          },
        });
      }
      if (target.agentId === "other") {
        expect(h.sessions.state.result).toBe(before);
      }
      // The retained window cannot cost a second full pass over the same rows.
      const projectedRows = project.mock.calls.reduce(
        (total, [, projected]) => total + projected.length,
        0,
      );
      expect(projectedRows).toBeLessThanOrEqual(size * events);
    }
    project.mockRestore();
    const window = h.sessions.state.result!;
    expect(window.sessions[0]).toMatchObject({ key: rows[1]!.key, label: `Live ${events - 1}` });
    expect(window.sessions.find((row) => row.key === h.gateway.snapshot.sessionKey)).toBe(
      foreground,
    );
    await vi.advanceTimersByTimeAsync(16000);
    expect(h.request).not.toHaveBeenCalled();
    h.select("writer");
    await vi.advanceTimersByTimeAsync(0);
    h.holdMain();
    h.select("main");
    expect(h.sessions.presentation.result).toBe(window);
  },
);

it.each([false, true])(
  "retains authoritative empty/page-window metadata (empty: %s)",
  async (empty) => {
    const h = await createWarmSelectionHarness();
    const first = { ...h.result("main"), hasMore: true, nextOffset: 1, totalCount: 2 };
    h.request.mockResolvedValueOnce(first);
    await h.sessions.refresh({ ...mainQuery, limit: 1 });
    const second = {
      ...sessionsResult(
        empty ? [] : [{ key: "agent:main:second", agentId: "main", kind: "direct", updatedAt: 2 }],
        2,
      ),
      hasMore: false,
      nextOffset: null,
      totalCount: empty ? 0 : 2,
    };
    h.request.mockResolvedValueOnce(second);
    await h.sessions.refresh({
      ...mainQuery,
      limit: 1,
      ...(empty ? {} : { append: true, offset: 1 }),
    });
    const window = h.sessions.state.result;
    expect(window?.sessions).toHaveLength(empty ? 0 : 2);
    h.select("writer");
    await vi.advanceTimersByTimeAsync(0);
    h.holdMain();
    h.select("main");
    expect(h.sessions.presentation.result).toEqual(window);
    expect(h.sessions.presentation.result).toMatchObject({
      hasMore: false,
      nextOffset: null,
      totalCount: empty ? 0 : 2,
    });
  },
);

it.each(["archive", "delete"] as const)(
  "notifies consumers when a displayed warm window is invalidated by %s",
  async (reason) => {
    const h = await createWarmSelectionHarness();
    h.select("writer");
    await vi.advanceTimersByTimeAsync(0);
    h.gateway.snapshot.sessionKey = "agent:writer:main";
    h.holdMain();
    h.select("main");
    await vi.advanceTimersByTimeAsync(0);
    let displayed = h.sessions.presentation.result;
    cleanup.push(
      h.sessions.subscribe(() => {
        displayed = h.sessions.presentation.result;
      }),
    );
    expect(displayed).toEqual(h.result("main"));
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        agentId: "main",
        sessionKey: "agent:main:main",
        reason,
        session: {
          key: "agent:main:main",
          agentId: "main",
          sessionId: "main-incarnation",
          archived: true,
        },
      },
    });
    expect(h.sessions.presentation.result).toBeNull();
    expect(displayed).toBeNull();
  },
);
