// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
  it("applies participant snapshots locally while refreshing involvement-filtered membership", async () => {
    vi.useFakeTimers();
    const participants = [{ identity: { type: "profile" as const, id: "viewer" } }];
    const updated = { ...settledChild, participants, participantCount: 1 };
    let participated = false;
    const request = vi.fn(async (_method: string, params?: unknown) =>
      sessionsResult(
        asOptionalRecord(params)?.involvingMe
          ? participated
            ? [updated]
            : []
          : [child, parent, grandparent],
        100,
      ),
    );
    const gateway = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway.gateway);
    const query = { agentId: "main", involvingMe: true };
    const stop = sessions.subscribeList(query, () => {});
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList({ ...query, force: true });
      request.mockClear();
      participated = true;
      gateway.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          reason: "participants",
          session: updated,
          ancestorSessions: [settledParent, settledGrandparent],
          ts: 101,
        },
      });
      expect(sessions.state.result?.sessions[0]).toEqual(updated);
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "sessions.list",
        expect.objectContaining({ involvingMe: true }),
      );
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([updated]);
    } finally {
      stop();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["sessions.changed", "session.message"])(
    "keeps %s ancestor references equivalent to full snapshots without roster or descriptor reads",
    async (event) => {
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
                event,
                payload: {
                  agentId: "main",
                  ...(event === "sessions.changed"
                    ? { reason: "agent.input.settled" }
                    : { phase: "end" }),
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
    },
  );

  it.each(["unknown", "generation", "list replacement", "local edit"])(
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
                key: change === "unknown" ? "agent:main:unknown" : parent.key,
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

  it.each(["omitted", "null"])("keeps %s ancestor clears over a stale read", async (clear) => {
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
                    ...(clear === "null" ? { activitySummary: null } : {}),
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
      await vi.advanceTimersByTimeAsync(5_000);
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
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.request).toHaveBeenCalledTimes(1);
      } finally {
        h.sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
