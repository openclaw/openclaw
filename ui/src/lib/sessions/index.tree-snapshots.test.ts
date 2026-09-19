// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { readSessionChangedEvent } from "./reconcile.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const settledGrandparent: GatewaySessionRow = {
  key: "agent:main:grandparent",
  sessionId: "grandparent-id",
  kind: "direct",
  updatedAt: 10,
  childSessions: ["agent:main:parent"],
};
const grandparent: GatewaySessionRow = { ...settledGrandparent, hasActiveSubagentRun: true };
const settledParent: GatewaySessionRow = {
  key: "agent:main:parent",
  sessionId: "parent-id",
  kind: "direct",
  updatedAt: 20,
  spawnedBy: grandparent.key,
  childSessions: ["agent:main:subagent:child"],
};
const parent: GatewaySessionRow = {
  ...settledParent,
  hasActiveSubagentRun: true,
  swarm: {
    groups: [{ groupId: "work", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 }],
    otherActiveGroups: 0,
  },
};
const child: GatewaySessionRow = {
  key: "agent:main:subagent:child",
  sessionId: "child-id",
  kind: "direct",
  updatedAt: 100,
  spawnedBy: parent.key,
  hasActiveRun: true,
  status: "running",
};
const settledChild = { ...child, updatedAt: 101, hasActiveRun: false, status: "done" as const };

function treeHarness(rows = [child, parent, grandparent]) {
  let response: Promise<SessionsListResult> | undefined;
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return response ?? sessionsResult(rows, 100);
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway.gateway);
  return {
    sessions,
    request,
    emit: gateway.emitEvent,
    holdRead: () => {
      const pending = createDeferred<SessionsListResult>();
      response = pending.promise;
      return pending;
    },
    settle: (event = "sessions.changed") =>
      gateway.emitEvent({
        type: "event",
        event,
        payload: {
          agentId: "main",
          ...(event === "sessions.changed" ? { reason: "agent.input.settled" } : { phase: "end" }),
          session: settledChild,
          ancestorSessions: [settledParent, settledGrandparent],
          ts: 101,
        },
      }),
  };
}

describe("tree row snapshots", () => {
  it.each(["sessions.changed", "session.message"])(
    "applies %s to held ancestors and descriptors without reading the window",
    async (event) => {
      vi.useFakeTimers();
      const h = treeHarness();
      const invalidated = vi.fn();
      const observer = h.sessions.observeRow(
        { key: parent.key, agentId: "main" },
        () => undefined,
        {
          onInvalidate: invalidated,
        },
      );
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        h.request.mockClear();
        h.settle(event);
        expect(h.sessions.state.result?.sessions).toEqual([
          settledChild,
          settledParent,
          settledGrandparent,
        ]);
        expect(observer.row).toEqual(settledParent);
        expect(invalidated).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.request).not.toHaveBeenCalled();
      } finally {
        observer.dispose();
        h.sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps complete viewer snapshots authoritative over stale envelope row fields", async () => {
    vi.useFakeTimers();
    const current: GatewaySessionRow = {
      key: "agent:main:controller",
      sessionId: "controller-id",
      kind: "direct",
      updatedAt: 21,
    };
    const staleTree = {
      childSessions: ["agent:main:hidden-child"],
      hasActiveSubagentRun: true,
      swarm: parent.swarm,
    };
    const h = treeHarness([{ ...current, updatedAt: 20, ...staleTree }]);
    const payload = {
      agentId: "main",
      reason: "patch",
      phase: "end",
      runId: "controller-run",
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
      permissionMode: null,
      thinkingLevel: null,
      ...staleTree,
      session: current,
      ancestorSessions: [],
      ts: 22,
    };
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      h.request.mockClear();
      h.emit({ type: "event", event: "sessions.changed", payload });
      expect(h.sessions.state.result?.sessions).toEqual([current]);
      expect(readSessionChangedEvent(payload)).toMatchObject({
        runId: "controller-run",
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        hasPermissionMode: true,
        thinkingLevel: null,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      h.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("orders an ancestor's field receipts by its own clock and fences an earlier list read", async () => {
    vi.useFakeTimers();
    const h = treeHarness([child, { ...parent, derivedTitle: "Original title" }, grandparent]);
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.holdRead();
      const refresh = h.sessions.refresh({ agentId: "main", force: true });
      h.settle();
      h.emit({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          reason: "patch",
          session: { ...settledParent, updatedAt: 21, label: "New parent label" },
          ancestorSessions: [settledGrandparent],
          ts: 102,
        },
      });
      pending.resolve(
        sessionsResult([child, { ...parent, derivedTitle: "Enriched title" }, grandparent], 100),
      );
      await refresh;
      expect(h.sessions.state.result?.sessions.find((row) => row.key === parent.key)).toEqual({
        ...settledParent,
        updatedAt: 21,
        label: "New parent label",
        derivedTitle: "Enriched title",
      });
      expect(h.sessions.state.result?.sessions.find((row) => row.key === grandparent.key)).toEqual(
        settledGrandparent,
      );
    } finally {
      h.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("updates an ancestor in the selected agent without admitting its foreign child", async () => {
    vi.useFakeTimers();
    const h = treeHarness([parent, grandparent]);
    const nextParent = { ...settledParent, childSessions: ["agent:worker:subagent:child"] };
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      h.request.mockClear();
      h.emit({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "worker",
          reason: "agent.input.settled",
          session: { ...settledChild, key: "agent:worker:subagent:child" },
          ancestorSessions: [nextParent, settledGrandparent],
          ts: 101,
        },
      });
      expect(h.sessions.state.result?.sessions).toEqual([nextParent, settledGrandparent]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      h.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["incomplete", "lineage", "generation", "unknown ancestor"])(
    "retains authoritative refresh for an %s tree update",
    async (change) => {
      vi.useFakeTimers();
      const h = treeHarness();
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        h.request.mockClear();
        h.emit({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: "patch",
            session: {
              ...settledChild,
              archived: false,
              ...(change === "lineage" ? { spawnedBy: grandparent.key } : {}),
            },
            ...(change === "incomplete"
              ? {}
              : {
                  ancestorSessions: [
                    {
                      ...settledParent,
                      ...(change === "generation" ? { sessionId: "retired-parent" } : {}),
                    },
                    settledGrandparent,
                    ...(change === "unknown ancestor"
                      ? [{ ...grandparent, key: "agent:main:unknown" }]
                      : []),
                  ],
                }),
          },
        });
        expect(
          h.sessions.state.result?.sessions.some((row) => row.key === "agent:main:unknown"),
        ).toBe(false);
        expect(
          h.sessions.state.result?.sessions.find((row) => row.key === parent.key)?.sessionId,
        ).toBe(parent.sessionId);
        await vi.advanceTimersByTimeAsync(200);
        expect(h.request).toHaveBeenCalledTimes(1);
      } finally {
        h.sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
