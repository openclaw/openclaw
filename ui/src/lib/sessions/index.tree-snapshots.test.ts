// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  it("keeps session.message ancestor references equivalent to full snapshots without roster or descriptor reads", async () => {
    vi.useFakeTimers();
    const outcomes: GatewaySessionRow[][] = [];
    const summary = { state: "stale" as const, canEnsure: true };
    try {
      for (const references of [true, false]) {
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
          for (const snapshotAt of [101, 102, 103]) {
            const ancestors = [
              {
                ...settledParent,
                activitySummary: summary,
                totalTokensFresh: false,
                snapshotAt,
                ancestorRevision: "parent-revision",
              },
              {
                ...settledGrandparent,
                totalTokensFresh: false,
                snapshotAt,
                ancestorRevision: "grandparent-revision",
              },
            ];
            h.emit({
              type: "event",
              event: "session.message",
              payload: {
                agentId: "main",
                phase: "end",
                session: { ...settledChild, snapshotAt },
                ancestorSessions: references && snapshotAt > 101 ? [] : ancestors,
                ...(references && snapshotAt > 101
                  ? {
                      ancestorSessionRefs: ancestors.map(
                        ({ key, sessionId, ancestorRevision }) => ({
                          key,
                          sessionId,
                          revision: ancestorRevision,
                          snapshotAt,
                        }),
                      ),
                    }
                  : {}),
                ts: snapshotAt,
              },
            });
            if (snapshotAt === 102) {
              // Page reads omit opt-in recaps and retain the wire's empty usage marker.
              const read = h.holdRead();
              const refresh = h.sessions.refreshList({
                agentId: "main",
                includeUnknown: false,
                force: true,
              });
              read.resolve(
                sessionsResult(
                  [
                    { ...settledChild, totalTokensFresh: false, snapshotAt },
                    { ...settledParent, totalTokensFresh: false, snapshotAt },
                    { ...settledGrandparent, totalTokensFresh: false, snapshotAt },
                  ],
                  snapshotAt,
                ),
              );
              await refresh;
              h.request.mockClear();
            }
          }
          // Snapshot clocks are sampling metadata, not a row-content difference.
          outcomes.push(
            h.sessions.state.result!.sessions.map(({ snapshotAt: _clock, ...row }) => row),
          );
          expect(observer.row).toMatchObject(settledParent);
          expect(invalidated).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(h.request).not.toHaveBeenCalled();
        } finally {
          observer.dispose();
          h.sessions.dispose();
        }
      }
      expect(outcomes).toEqual([
        [settledChild, { ...settledParent, activitySummary: summary }, settledGrandparent],
        [settledChild, { ...settledParent, activitySummary: summary }, settledGrandparent],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["generation", "list replacement", "local edit"])(
    "refreshes instead of certifying an ancestor reference after %s",
    async (change) => {
      vi.useFakeTimers();
      const h = treeHarness();
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        h.emit({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: "patch",
            session: settledChild,
            ancestorSessions: [
              { ...settledParent, snapshotAt: 100, ancestorRevision: "parent-revision" },
              { ...settledGrandparent, snapshotAt: 100, ancestorRevision: "grandparent-revision" },
            ],
          },
        });
        if (change === "list replacement") {
          const read = h.holdRead();
          const refresh = h.sessions.refresh({ agentId: "main", force: true });
          read.resolve(
            sessionsResult(
              [
                settledChild,
                { ...settledParent, snapshotAt: 100, label: "Replaced in the same millisecond" },
                settledGrandparent,
              ],
              100,
            ),
          );
          await refresh;
        } else if (change === "local edit") {
          h.sessions.patchRowLocal(parent.key, { label: "Local replacement" });
        }
        h.request.mockClear();
        const held = h.sessions.state.result?.sessions.find((row) => row.key === parent.key);
        h.emit({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: "patch",
            session: settledChild,
            ancestorSessions: [settledGrandparent],
            ancestorSessionRefs: [
              {
                key: parent.key,
                sessionId: change === "generation" ? "replaced-parent-id" : parent.sessionId,
                revision: "parent-revision",
                snapshotAt: 101,
              },
            ],
          },
        });
        expect(h.sessions.state.result?.sessions.find((row) => row.key === parent.key)).toEqual(
          held,
        );
        expect(
          h.sessions.state.result?.sessions.some((row) => row.key === "agent:main:unknown"),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.request).toHaveBeenCalledOnce();
      } finally {
        h.sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps null ancestor clears over a stale read", async () => {
    vi.useFakeTimers();
    const activitySummary = { state: "stale" as const, canEnsure: true };
    const h = treeHarness([
      child,
      { ...parent, label: "Cleared label", activitySummary, snapshotAt: 100 },
      grandparent,
    ]);
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const emit = (reference: boolean) =>
        h.emit({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: "patch",
            session: settledChild,
            ancestorSessions: reference
              ? [settledGrandparent]
              : [
                  {
                    ...settledParent,
                    activitySummary: null,
                    ancestorRevision: "parent-revision",
                    snapshotAt: 101,
                  },
                  settledGrandparent,
                ],
            ...(reference
              ? {
                  ancestorSessionRefs: [
                    {
                      key: parent.key,
                      sessionId: parent.sessionId,
                      revision: "parent-revision",
                      snapshotAt: 103,
                    },
                  ],
                }
              : {}),
          },
        });
      emit(false);
      const pending = h.holdRead();
      const refresh = h.sessions.refresh({ agentId: "main", force: true });
      emit(true);
      pending.resolve(
        sessionsResult(
          [
            settledChild,
            { ...settledParent, label: "Stale read label", activitySummary, snapshotAt: 102 },
            settledGrandparent,
          ],
          102,
        ),
      );
      await refresh;
      const { snapshotAt: _clock, ...retainedRow } = h.sessions.state.result!.sessions.find(
        (candidate) => candidate.key === parent.key,
      )!;
      expect(retainedRow).toEqual(settledParent);
    } finally {
      h.sessions.dispose();
      vi.useRealTimers();
    }
  });

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
      await vi.advanceTimersByTimeAsync(5_000);
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

  it("retains authoritative refresh for an unknown ancestor tree update", async () => {
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
          },
          ancestorSessions: [
            settledParent,
            settledGrandparent,
            { ...grandparent, key: "agent:main:unknown" },
          ],
        },
      });
      expect(
        h.sessions.state.result?.sessions.some((row) => row.key === "agent:main:unknown"),
      ).toBe(false);
      expect(
        h.sessions.state.result?.sessions.find((row) => row.key === parent.key)?.sessionId,
      ).toBe(parent.sessionId);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.request).toHaveBeenCalledTimes(1);
    } finally {
      h.sessions.dispose();
      vi.useRealTimers();
    }
  });
});

describe("child roster refresh", () => {
  const parentKey = "agent:main:parent";
  const known: GatewaySessionRow = {
    key: "agent:worker:subagent:known",
    sessionId: "known-session",
    kind: "direct",
    spawnedBy: parentKey,
    updatedAt: 1,
  };
  const added: GatewaySessionRow = {
    key: "agent:research:subagent:added",
    sessionId: "added-session",
    kind: "direct",
    parentSessionKey: parentKey,
    updatedAt: 2,
  };

  it.each([
    {
      name: "a known child run finishing",
      payload: {},
      terminal: { sessionKeys: [known.key], status: "done" as const, endedAt: 2 },
      refresh: true,
    },
    {
      name: "an unknown run finishing outside an incomplete child window",
      payload: {},
      terminal: { sessionKeys: ["agent:research:unloaded"], status: "done" as const, endedAt: 2 },
      refresh: true,
      incomplete: true,
    },
    {
      name: "accepted history discovering a child",
      payload: {},
      historyRow: { ...added, agentId: "research" },
      refresh: true,
      rows: [known, added],
    },
    {
      name: "unrelated same-agent root",
      payload: { sessionKey: "agent:main:other", reason: "update" },
      refresh: false,
    },
    {
      name: "known child deletion before list reconciliation",
      payload: { sessionKey: known.key, sessionId: known.sessionId, reason: "delete" },
      refresh: true,
      rows: [],
    },
    {
      name: "key-only lifecycle deletion",
      payload: { sessionKey: known.key, reason: "delete" },
      refresh: true,
      rows: [],
    },
    {
      name: "known child moved to another parent",
      payload: {
        sessionKey: known.key,
        session: { ...known, spawnedBy: "agent:other:parent", updatedAt: 2 },
        reason: "move",
      },
      refresh: true,
      rows: [],
    },
  ])(
    "refreshes a parent-scoped child query only for $name",
    async ({ payload, historyRow, terminal, refresh, rows, incomplete }) => {
      vi.useFakeTimers();
      let currentRows = [known];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const children = isRecord(params) && params.spawnedBy === parentKey;
        return {
          ...sessionsResult(children ? currentRows : [], 1),
          hasMore: children && incomplete === true,
          totalCount: children && incomplete ? 10_001 : children ? currentRows.length : 0,
        };
      });
      const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      const query = {
        spawnedBy: parentKey,
        limit: 10_000,
        includeGlobal: false,
        includeUnknown: false,
      };
      const observer = sessions.observeList(query, () => undefined);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        await observer.refresh();
        request.mockClear();
        currentRows = rows ?? currentRows;
        if (historyRow) {
          expect(
            sessions.captureReconcile()(historyRow, undefined, {
              resultAgentId: historyRow.agentId,
            }),
          ).toBe(true);
        } else if (terminal) {
          sessions.reconcileRunTerminal(terminal);
        } else {
          emitEvent({ type: "event", event: "sessions.changed", payload });
        }
        await vi.advanceTimersByTimeAsync(5_000);
        const childRequests = request.mock.calls.filter(
          ([, params]) => isRecord(params) && params.spawnedBy === parentKey,
        );
        expect(childRequests).toHaveLength(refresh ? 1 : 0);
        if (refresh) {
          expect(sessions.listSnapshot(query).result?.sessions.map((entry) => entry.key)).toEqual(
            currentRows.map((entry) => entry.key),
          );
        }
      } finally {
        observer.dispose();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
