// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { readSessionChangedEvent } from "./reconcile.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const cleanup: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  vi.useRealTimers();
});

function makeRow(
  key: string,
  sessionId: string,
  updatedAt: number,
  fields: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key, sessionId, kind: "direct", updatedAt, ...fields };
}
const settledGrandparent = makeRow("agent:main:grandparent", "grandparent-id", 10, {
  childSessions: ["agent:main:parent"],
});
const grandparent: GatewaySessionRow = { ...settledGrandparent, hasActiveSubagentRun: true };
const settledParent = makeRow("agent:main:parent", "parent-id", 20, {
  spawnedBy: grandparent.key,
  childSessions: ["agent:main:subagent:child"],
});
const parent: GatewaySessionRow = {
  ...settledParent,
  hasActiveSubagentRun: true,
  swarm: {
    groups: [{ groupId: "work", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 }],
    otherActiveGroups: 0,
  },
};
const child = makeRow("agent:main:subagent:child", "child-id", 100, {
  spawnedBy: parent.key,
  hasActiveRun: true,
  status: "running",
});
const settledChild = { ...child, updatedAt: 101, hasActiveRun: false, status: "done" as const };
const summary = { state: "stale" as const, canEnsure: true };
const revision = (row: GatewaySessionRow) => `${row.sessionId?.replace("-id", "")}-revision`;
const certified = (row: GatewaySessionRow, snapshotAt: number) => ({
  ...row,
  snapshotAt,
  ancestorRevision: revision(row),
});
const reference = (row: GatewaySessionRow, snapshotAt: number) => ({
  key: row.key,
  sessionId: row.sessionId,
  revision: revision(row),
  snapshotAt,
});

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
  cleanup.push(sessions.dispose);
  const emit = (payload: Record<string, unknown>, event = "sessions.changed") =>
    gateway.emitEvent({ type: "event", event, payload });
  return {
    sessions,
    request,
    row: (key = parent.key) => sessions.state.result?.sessions.find((row) => row.key === key),
    emit,
    patch: (fields: Record<string, unknown>) =>
      emit({ agentId: "main", reason: "patch", session: settledChild, ...fields }),
    holdRead: () => {
      const pending = createDeferred<SessionsListResult>();
      response = pending.promise;
      return pending;
    },
  };
}

describe("tree row snapshots", () => {
  it("keeps session.message ancestor references equivalent to full snapshots without roster or descriptor reads", async () => {
    const outcomes: GatewaySessionRow[][] = [];
    for (const references of [true, false]) {
      const h = treeHarness();
      const invalidated = vi.fn();
      const observer = h.sessions.observeRow(
        { key: parent.key, agentId: "main" },
        () => undefined,
        { onInvalidate: invalidated },
      );
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        h.request.mockClear();
        for (const snapshotAt of [101, 102, 103]) {
          const ancestors = [
            { ...settledParent, activitySummary: summary },
            settledGrandparent,
          ].map((row) => Object.assign(certified(row, snapshotAt), { totalTokensFresh: false }));
          h.emit(
            {
              agentId: "main",
              phase: "end",
              session: { ...settledChild, snapshotAt },
              ancestorSessions: references && snapshotAt > 101 ? [] : ancestors,
              ...(references && snapshotAt > 101
                ? {
                    ancestorSessionRefs: ancestors.map((row) => reference(row, snapshotAt)),
                  }
                : {}),
              ts: snapshotAt,
            },
            "session.message",
          );
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
                [settledChild, settledParent, settledGrandparent].map((row) =>
                  Object.assign({}, row, { totalTokensFresh: false, snapshotAt }),
                ),
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
  });

  it.each(["generation", "list replacement", "local edit"])(
    "refreshes instead of certifying an ancestor reference after %s",
    async (change) => {
      const h = treeHarness();
      await h.sessions.refresh({ agentId: "main", force: true });
      h.patch({
        ancestorSessions: [settledParent, settledGrandparent].map((row) => certified(row, 100)),
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
      const held = h.row();
      h.patch({
        ancestorSessions: [settledGrandparent],
        ancestorSessionRefs: [
          {
            ...reference(parent, 101),
            sessionId: change === "generation" ? "replaced-parent-id" : parent.sessionId,
          },
        ],
      });
      expect(h.row()).toEqual(held);
      expect(h.sessions.state.result).not.toBeNull();
      expect(h.row("agent:main:unknown")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it("keeps null ancestor clears through a compact reference", async () => {
    const h = treeHarness([
      child,
      { ...parent, label: "Cleared label", activitySummary: summary, snapshotAt: 100 },
      grandparent,
    ]);
    await h.sessions.refresh({ agentId: "main", force: true });
    h.patch({
      ancestorSessions: [
        { ...certified(settledParent, 101), activitySummary: null },
        settledGrandparent,
      ],
    });
    h.patch({
      ancestorSessions: [settledGrandparent],
      ancestorSessionRefs: [reference(parent, 103)],
    });
    const { snapshotAt: _clock, ...retainedRow } = h.row()!;
    expect(retainedRow).toEqual(settledParent);
  });

  it("keeps complete viewer snapshots authoritative over stale envelope row fields", async () => {
    const current = makeRow("agent:main:controller", "controller-id", 21);
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
    await h.sessions.refresh({ agentId: "main", force: true });
    h.request.mockClear();
    h.emit(payload);
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
  });

  it("retains authoritative refresh for an unknown ancestor tree update", async () => {
    const h = treeHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    h.request.mockClear();
    h.patch({
      session: { ...settledChild, archived: false },
      ancestorSessions: [
        settledParent,
        settledGrandparent,
        { ...grandparent, key: "agent:main:unknown" },
      ],
    });
    expect(h.row("agent:main:unknown")).toBeUndefined();
    expect(h.row()?.sessionId).toBe(parent.sessionId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe("child roster refresh", () => {
  const parentKey = "agent:main:parent";
  const known = makeRow("agent:worker:subagent:known", "known-session", 1, {
    spawnedBy: parentKey,
  });
  const added = makeRow("agent:research:subagent:added", "added-session", 2, {
    parentSessionKey: parentKey,
  });

  it.each([
    {
      name: "a known child run finishing",
      terminal: { sessionKeys: [known.key], status: "done" as const, endedAt: 2 },
    },
    {
      name: "an unknown run finishing outside an incomplete child window",
      terminal: { sessionKeys: ["agent:research:unloaded"], status: "done" as const, endedAt: 2 },
      incomplete: true,
    },
    {
      name: "accepted history discovering a child",
      historyRow: { ...added, agentId: "research" },
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
      rows: [],
    },
    {
      name: "key-only lifecycle deletion",
      payload: { sessionKey: known.key, reason: "delete" },
      rows: [],
    },
    {
      name: "known child moved to another parent",
      payload: {
        sessionKey: known.key,
        session: { ...known, spawnedBy: "agent:other:parent", updatedAt: 2 },
        reason: "move",
      },
      rows: [],
    },
  ])(
    "refreshes a parent-scoped child query only for $name",
    async ({ payload = {}, historyRow, terminal, refresh = true, rows, incomplete }) => {
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
      cleanup.push(sessions.dispose);
      const query = {
        spawnedBy: parentKey,
        limit: 10_000,
        includeGlobal: false,
        includeUnknown: false,
      };
      const observer = sessions.observeList(query, () => undefined);
      cleanup.push(observer.dispose);
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
    },
  );
});
