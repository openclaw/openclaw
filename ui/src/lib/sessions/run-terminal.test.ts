// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { reconcileSessionRunTerminal } from "./index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

function sessionsResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("reconcileSessionRunTerminal yielded parent", () => {
  it("settles the owned model run while keeping parent work pending", () => {
    const result = sessionsResult([
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        status: "running",
        startedAt: 100,
      },
    ]);

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "running",
        endedAt: 160,
      }),
    ).toEqual({
      ...result,
      sessions: [
        {
          ...result.sessions[0],
          activeRunIds: [],
          hasActiveRun: false,
          status: "running",
          endedAt: 160,
          runtimeMs: 60,
          abortedLastRun: false,
        },
      ],
    });
  });

  it("preserves overlapping active runs when one model turn yields", () => {
    const result = sessionsResult([
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1", "run-2"],
        status: "running",
        startedAt: 100,
      },
    ]);

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "running",
        endedAt: 160,
      }),
    ).toEqual({
      ...result,
      sessions: [
        {
          ...result.sessions[0],
          activeRunIds: ["run-2"],
          hasActiveRun: true,
          status: "running",
        },
      ],
    });
  });
});

async function terminalOwner(initial: GatewaySessionRow, owner: "primary" | "managed") {
  vi.useFakeTimers();
  const sibling: GatewaySessionRow = {
    key: "agent:main:unrelated",
    sessionId: "unrelated-session",
    kind: "direct",
    updatedAt: 10,
  };
  const listResult = (row: GatewaySessionRow): SessionsListResult => ({
    ...sessionsResult([row, sibling]),
    totalCount: 7,
    hasMore: true,
    nextOffset: 2,
  });
  let response: ReturnType<typeof createDeferred<SessionsListResult>> | undefined;
  const pending: Promise<void>[] = [];
  const client = createTestGatewayClient(async (_method, params) => {
    if (owner === "managed" && !(params as { ownerId?: string }).ownerId) {
      return sessionsResult([sibling]);
    }
    return response?.promise ?? listResult({ ...initial });
  });
  const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
  const query = { agentId: "main", ownerId: "ada" };
  const updates = vi.fn();
  const stop =
    owner === "managed" ? sessions.subscribeList(query, updates) : sessions.subscribe(updates);
  onTestFinished(async () => {
    stop();
    sessions.dispose();
    response?.resolve(listResult(initial));
    await Promise.all(pending);
    vi.useRealTimers();
  });
  await sessions.refresh({ agentId: "main", force: true });
  const refresh = () =>
    owner === "managed"
      ? sessions.refreshList(query)
      : sessions.refresh({ agentId: "main", force: true });
  if (owner === "managed") {
    await refresh();
  }
  const result = () =>
    owner === "managed" ? sessions.listSnapshot(query).result : sessions.state.result;
  return {
    sessions,
    updates,
    result,
    row: () => result()?.sessions.find((row) => row.key === initial.key),
    holdRead() {
      response = createDeferred<SessionsListResult>();
      const settled = refresh();
      pending.push(settled);
      const resolve = response.resolve;
      return { settled, resolve: (row: GatewaySessionRow) => resolve(listResult(row)) };
    },
  };
}

describe("terminal metadata ownership", () => {
  const previousTerminal: GatewaySessionRow = {
    key: "agent:main:terminal",
    sessionId: "terminal-session",
    kind: "direct",
    updatedAt: 200,
    derivedTitle: "Initial title",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["new-run"],
    lastRunId: "old-run",
    startedAt: 100,
    endedAt: 200,
    runtimeMs: 100,
  };

  it.each(
    (["done", "failed", "killed", "timeout"] as const).flatMap((status) =>
      (["primary", "managed"] as const).map((owner) => ({ status, owner })),
    ),
  )("replaces the preceding terminal tuple for $owner $status", async ({ status, owner }) => {
    const initial = {
      ...previousTerminal,
      abortedLastRun: status === "done",
      ...(status !== "done" ? { lastRunError: "Previous run failed" } : {}),
    };
    const h = await terminalOwner(initial, owner);
    const primary = h.sessions.state.result;
    const oldRead = h.holdRead();
    const terminal = { sessionKeys: [initial.key], runId: "new-run", status, endedAt: 400 };

    expect(h.sessions.reconcileRunTerminal(terminal)).toBe(true);
    expect(h.row()).toMatchObject({
      status,
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: "new-run",
      endedAt: 400,
      abortedLastRun: status === "killed",
      updatedAt: 200,
    });
    expect(h.row()?.startedAt).toBeUndefined();
    expect(h.row()?.runtimeMs).toBeUndefined();
    expect(h.row()?.lastRunError).toBeUndefined();
    const settled = h.result();
    h.updates.mockClear();
    expect(h.sessions.reconcileRunTerminal({ ...terminal, endedAt: 900 })).toBe(false);
    expect(h.result()).toBe(settled);
    expect(h.updates).not.toHaveBeenCalled();

    oldRead.resolve({ ...initial, derivedTitle: "Read title", updatedAt: 250 });
    await oldRead.settled;
    expect(h.row()).toMatchObject({
      derivedTitle: "Read title",
      updatedAt: 250,
      lastRunId: "new-run",
      endedAt: 400,
      abortedLastRun: status === "killed",
      status,
      hasActiveRun: false,
      activeRunIds: [],
    });
    expect(h.row()?.startedAt).toBeUndefined();
    expect(h.row()?.runtimeMs).toBeUndefined();
    expect(h.row()?.lastRunError).toBeUndefined();
    expect(h.result()).toMatchObject({ count: 2, totalCount: 7, hasMore: true, nextOffset: 2 });
    expect(h.result()?.sessions.map((row) => row.key)).toEqual([
      initial.key,
      "agent:main:unrelated",
    ]);
    if (owner === "managed") {
      expect(h.sessions.state.result).toBe(primary);
    }
  });

  it.each(["failed", "timeout"] as const)(
    "uses only the new %s detail after a previously killed run",
    async (status) => {
      const h = await terminalOwner({ ...previousTerminal, abortedLastRun: true }, "primary");
      h.sessions.reconcileRunTerminal({
        sessionKeys: [previousTerminal.key],
        runId: "new-run",
        status,
        endedAt: 400,
        errorMessage: "Current run\nfailed: password=synthetic-password",
      });
      expect(h.row()).toMatchObject({
        status,
        lastRunId: "new-run",
        lastRunError: "Current run failed: password=[redacted]",
        abortedLastRun: false,
      });
    },
  );

  it.each([
    "same done",
    "same failed",
    "same killed",
    "same timeout",
    "unknown IDs",
    "foreign ID",
    "overlap",
    "missing previous ID",
    "idle",
    "queued",
    "running",
  ] as const)("preserves unowned or same-run timing (%s)", async (mode) => {
    const same = mode.startsWith("same ");
    const status: SessionRunStatus =
      mode === "same failed"
        ? "failed"
        : mode === "same killed"
          ? "killed"
          : mode === "same timeout"
            ? "timeout"
            : mode === "queued" || mode === "running"
              ? mode
              : "done";
    const initial = {
      ...previousTerminal,
      lastRunId: same ? "new-run" : mode === "missing previous ID" ? undefined : "old-run",
      status: same || mode === "idle" ? status : ("running" as const),
      hasActiveRun: mode !== "idle",
      activeRunIds:
        mode === "unknown IDs"
          ? undefined
          : mode === "foreign ID"
            ? ["other-run"]
            : mode === "overlap"
              ? ["new-run", "other-run"]
              : mode === "idle"
                ? []
                : ["new-run"],
      abortedLastRun: status === "killed",
      ...(status === "failed" || status === "timeout" ? { lastRunError: "Current failure" } : {}),
    };
    const h = await terminalOwner(initial, "primary");
    const previous = h.result();
    h.updates.mockClear();
    const changed = h.sessions.reconcileRunTerminal({
      sessionKeys: [initial.key],
      runId: "new-run",
      status,
      endedAt: 900,
    });
    expect(h.row()).toMatchObject({
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
    });
    expect(h.row()?.lastRunId).toBe(initial.lastRunId);
    if (same) {
      expect(h.row()?.abortedLastRun).toBe(initial.abortedLastRun);
      expect(h.row()?.lastRunError).toBe(initial.lastRunError);
    }
    if (mode === "unknown IDs" || mode === "foreign ID" || mode === "idle") {
      expect(changed).toBe(false);
      expect(h.result()).toBe(previous);
      expect(h.updates).not.toHaveBeenCalled();
    }
    if (mode === "overlap") {
      expect(h.row()).toMatchObject({ hasActiveRun: true, activeRunIds: ["other-run"] });
    }
    if (mode === "queued" || mode === "running") {
      expect(h.row()?.status).toBe(mode);
    }
  });

  it.each([
    { lastRunId: "current-run", status: "done" },
    { lastRunId: undefined, status: "done" },
    { lastRunId: "previous-run", status: "queued" },
    { lastRunId: "previous-run", status: "running" },
  ] as const)(
    "preserves existing settlement for $lastRunId / $status",
    async ({ lastRunId, status }) => {
      const initial: GatewaySessionRow = {
        ...previousTerminal,
        lastRunId,
        status: "failed",
        lastRunError: "Recorded failure",
        hasActiveRun: false,
        activeRunIds: [],
      };
      const h = await terminalOwner(initial, "primary");

      expect(
        h.sessions.reconcileRunTerminal({
          sessionKeys: [initial.key],
          runId: "current-run",
          status,
          endedAt: 900,
        }),
      ).toBe(true);

      expect(h.row()).toMatchObject({
        lastRunId,
        status,
        hasActiveRun: false,
        activeRunIds: [],
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
      });
      expect(h.row()?.lastRunError).toBeUndefined();
    },
  );
});

describe("terminal observations", () => {
  it.each(
    (["done", "overlap", "confirmation", "foreign run", "later read"] as const).flatMap((mode) =>
      (["primary", "managed"] as const).map((owner) => ({ mode, owner })),
    ),
  )("orders accepted terminal facts against $owner reads ($mode)", async ({ mode, owner }) => {
    vi.useFakeTimers();
    const initial = {
      key: "agent:main:terminal",
      sessionId: "terminal-session",
      kind: "direct" as const,
      updatedAt: 10,
      derivedTitle: "Initial title",
      status: mode === "confirmation" ? ("done" as const) : ("running" as const),
      hasActiveRun: mode !== "confirmation",
      activeRunIds:
        mode === "confirmation" ? [] : mode === "overlap" ? ["run-a", "run-b"] : ["run-a"],
      startedAt: 100,
      ...(mode === "confirmation" ? { endedAt: 200, runtimeMs: 100 } : {}),
    };
    const delayed = createDeferred<SessionsListResult>();
    let hold = false;
    const client = createTestGatewayClient(async (_method, params) => {
      if (owner === "managed" && !(params as { ownerId?: string }).ownerId) {
        return sessionsResult([]);
      }
      return hold ? delayed.promise : sessionsResult([{ ...initial }]);
    });
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    const query = { agentId: "main", ownerId: "ada" };
    const listener = vi.fn();
    const stop =
      owner === "managed" ? sessions.subscribeList(query, listener) : sessions.subscribe(listener);
    const result = () =>
      owner === "managed" ? sessions.listSnapshot(query).result : sessions.state.result;
    const refresh = () =>
      owner === "managed"
        ? sessions.refreshList(query)
        : sessions.refresh({ agentId: "main", force: true });
    let pending: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      if (owner === "managed") {
        await refresh();
      }
      hold = true;
      if (mode !== "later read") {
        pending = refresh();
      }
      const previous = result();
      listener.mockClear();
      expect(
        sessions.reconcileRunTerminal({
          sessionKeys: [initial.key],
          runId: mode === "foreign run" ? "run-other" : "run-a",
          status: "done",
          endedAt: 200,
        }),
      ).toBe(mode === "done" || mode === "overlap" || mode === "later read");
      if (mode === "confirmation" || mode === "foreign run") {
        expect(result()).toBe(previous);
        expect(listener).not.toHaveBeenCalled();
      }
      if (mode === "later read") {
        pending = refresh();
      }
      delayed.resolve(
        sessionsResult([
          {
            ...initial,
            derivedTitle: "Read title",
            status: mode === "foreign run" ? "done" : "running",
            hasActiveRun: mode !== "foreign run",
            activeRunIds: mode === "foreign run" ? [] : ["run-a", "run-b"],
          },
        ]),
      );
      await pending;
      expect(result()?.sessions[0]).toMatchObject({
        derivedTitle: "Read title",
        status: mode === "overlap" || mode === "later read" ? "running" : "done",
        hasActiveRun: mode === "overlap" || mode === "later read",
        activeRunIds:
          mode === "later read" ? ["run-a", "run-b"] : mode === "overlap" ? ["run-b"] : [],
      });
    } finally {
      stop();
      sessions.dispose();
      delayed.resolve(sessionsResult([initial]));
      await pending;
      vi.useRealTimers();
    }
  });

  it.each(
    [false, true].flatMap((overlap) =>
      [false, true].map((includePrimary) => ({ overlap, includePrimary })),
    ),
  )(
    "checks the latest managed run across retained windows (overlap: $overlap, primary: $includePrimary)",
    async ({ overlap, includePrimary }) => {
      vi.useFakeTimers();
      const initial = {
        key: "agent:main:terminal",
        sessionId: "terminal-session",
        kind: "direct" as const,
        updatedAt: 10,
        hasActiveRun: true,
        activeRunIds: ["run-a"],
        status: "running" as const,
      };
      const current = { ...initial, activeRunIds: overlap ? ["run-a", "run-b"] : ["run-b"] };
      const client = createTestGatewayClient(async (_method, params) => {
        const ownerId = (params as { ownerId?: string }).ownerId;
        return sessionsResult(
          ownerId || includePrimary ? [{ ...(ownerId === "ada" ? current : initial) }] : [],
        );
      });
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      const query = { agentId: "main", ownerId: "ada" };
      const olderQuery = { ...query, ownerId: "grace" };
      const stop = sessions.subscribeList(query, () => {});
      const stopOlder = sessions.subscribeList(olderQuery, () => {});
      try {
        await sessions.refresh({ agentId: "main", force: true });
        await sessions.refreshList(olderQuery);
        await sessions.refreshList(query);
        expect(
          sessions.reconcileRunTerminal({
            sessionKeys: [initial.key],
            runId: "run-a",
            status: "done",
            endedAt: 200,
          }),
        ).toBe(overlap);
        const expectedOlder = {
          status: "running",
          hasActiveRun: true,
          activeRunIds: overlap ? ["run-b"] : ["run-a"],
        };
        if (includePrimary) {
          expect(sessions.state.result?.sessions[0]).toMatchObject(expectedOlder);
        } else {
          expect(sessions.state.result?.sessions).toEqual([]);
        }
        expect(sessions.listSnapshot(olderQuery).result?.sessions[0]).toMatchObject(expectedOlder);
        const visible = sessions.listSnapshot(query).result!.sessions[0]!;
        expect(visible).toMatchObject({
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["run-b"],
        });
        expect(visible.endedAt).toBeUndefined();
        expect(visible.runtimeMs).toBeUndefined();
      } finally {
        stop();
        stopOlder();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
