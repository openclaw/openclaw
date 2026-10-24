// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { SessionRowObservation } from "./index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionRowEventListener } from "./session-capability.ts";

const noop = () => undefined;

function expectAdmitted(
  listener: ReturnType<typeof vi.fn<SessionRowEventListener>>,
  event: GatewayEventFrame,
  row: Partial<GatewaySessionRow>,
) {
  expect(listener).toHaveBeenCalledExactlyOnceWith(
    event,
    expect.objectContaining({
      applied: true,
      admittedRow: expect.objectContaining(row),
    }),
  );
}

const frame = (event: string, payload: unknown, seq?: number): GatewayEventFrame => ({
  type: "event",
  event,
  payload,
  ...(seq === undefined ? {} : { seq }),
});
const change = (emit: (event: GatewayEventFrame) => void, payload: unknown) =>
  emit(frame("sessions.changed", payload));
const workTarget = { key: "global", agentId: "work" };

function ownedChange(
  emit: (event: GatewayEventFrame) => void,
  row: GatewaySessionRow,
  fields: Record<string, unknown>,
) {
  change(emit, { sessionKey: row.key, agentId: row.agentId, sessionId: row.sessionId, ...fields });
}

function globalRow(agentId: string, updatedAt: number, active = false): GatewaySessionRow {
  return {
    key: "global",
    kind: "global",
    agentId,
    sessionId: `${agentId}-global-session`,
    updatedAt,
    archived: false,
    label: agentId === "work" ? "Work descriptor" : "Main roster",
    status: active ? "running" : "done",
    hasActiveRun: active,
    activeRunIds: active ? ["work-run"] : [],
  };
}
const mainRow = globalRow("main", 900);
const workRow = globalRow("work", 200, true);

const terminal = {
  status: "done" as const,
  hasActiveRun: false,
  activeRunIds: [],
  lastRunId: "work-run",
  startedAt: 100,
  endedAt: 200,
  runtimeMs: 100,
};

async function descriptorOwner(
  initial: GatewaySessionRow,
  primary = mainRow,
  onInvalidate?: () => void,
) {
  const replies: unknown[] = [];
  const finishReplies: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  const disposers: Array<() => void> = [];
  const client = createTestGatewayClient(async (method) => {
    expect(method).toBe("sessions.list");
    if (replies.length === 0) {
      throw new Error(`Unexpected Gateway request: ${method}`);
    }
    return await replies.shift();
  });
  const { gateway, emitEvent, publish } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.push(promise.then(noop, noop));
    return promise;
  };
  const reply = (result: unknown) => replies.push(result);
  const hold = <T>(fallback: T) => {
    const deferred = createDeferred<T>();
    finishReplies.push(() => deferred.resolve(fallback));
    return deferred;
  };
  onTestFinished(async () => {
    disposers.forEach((dispose) => dispose());
    sessions.dispose();
    finishReplies.forEach((finish) => finish());
    await Promise.all(pending);
  });

  reply(sessionsResult([primary], 900));
  await sessions.refresh({ agentId: "main", force: true });
  const primaryResult = sessions.state.result;
  const revision = sessions.canonicalListRevision;
  const changed = vi.fn<(row: GatewaySessionRow | null) => void>();
  const observation = sessions.observeRow(workTarget, changed, {
    onInvalidate,
  });
  disposers.push(observation.dispose);
  expect(observation.row).toBeNull();
  expect(observation.captureReconcile()(initial)).toMatchObject({
    status: "current",
    row: initial,
  });
  changed.mockClear();

  const keepMain = () => {
    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.state.agentId).toBe("main");
    expect(sessions.canonicalListRevision).toBe(revision);
  };
  const holdWorkList = () => {
    const result = sessionsResult([initial], 200);
    const response = hold(result);
    reply(response.promise);
    const settled = track(sessions.refresh({ agentId: "work", force: true }));
    expect(sessions.state.loading).toBe(true);
    keepMain();
    return { response, settled };
  };
  const holdDescribe = (target = observation) => {
    const reconcile = target.captureReconcile();
    const response = hold<GatewaySessionRow>(initial);
    return { response, settled: track(response.promise.then(reconcile)) };
  };
  const settleRun = (fields: Partial<Parameters<typeof sessions.reconcileRunTerminal>[0]>) =>
    sessions.reconcileRunTerminal({
      sessionKeys: ["global"],
      agentId: "work",
      runId: "work-run",
      status: "done",
      endedAt: 400,
      ...fields,
    });
  return {
    sessions,
    observation,
    changed,
    emitEvent,
    publish,
    reply,
    disposers,
    holdWorkList,
    holdDescribe,
    keepMain,
    settleRun,
  };
}

describe("session row observations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("keeps completed Swarm details while an invalidated list settles before the fresh descriptor", async () => {
    const swarm: NonNullable<GatewaySessionRow["swarm"]> = {
      groups: [
        {
          groupId: "completed-swarm",
          createdAt: 1,
          queued: 0,
          running: 0,
          done: 1,
          failed: 0,
          children: [{ sessionKey: "agent:work:child", status: "done" }],
        },
      ],
      otherActiveGroups: 0,
    };
    const initial: GatewaySessionRow = { ...workRow, swarm };
    const invalidated = vi.fn();
    const h = await descriptorOwner(initial, mainRow, invalidated);
    const list = h.holdWorkList();
    change(h.emitEvent, { sessionKey: initial.key, agentId: "work", reason: "swarm" });
    expect(invalidated).toHaveBeenCalledOnce();
    const fresh = h.holdDescribe();
    h.changed.mockClear();

    // List summaries omit the members supplied by the detailed descriptor read.
    const listed = {
      ...initial,
      swarm: {
        ...swarm,
        groups: swarm.groups.map(({ children: _children, ...group }) => group),
      },
    };
    list.response.resolve(sessionsResult([structuredClone(listed)], 200));
    await list.settled;
    expect(h.observation.row).toEqual(initial);
    expect(h.changed).not.toHaveBeenCalledWith(null);

    const settled: GatewaySessionRow = {
      ...structuredClone(initial),
      updatedAt: 201,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    };
    fresh.response.resolve(settled);
    expect(await fresh.settled).toMatchObject({ status: "current", row: settled });
    expect(h.observation.row).toEqual(settled);
    expect(h.changed).toHaveBeenLastCalledWith(settled);
  });

  it("invalidates descriptor reads only for the observed target and current connection", async () => {
    const { gateway, emitEvent, publish } = createGatewayHarness(
      createTestGatewayClient(async () => sessionsResult([], 1)),
    );
    const sessions = createTestSessionCapability(gateway);
    const invalidated = vi.fn();
    const delivered = vi.fn<SessionRowEventListener>();
    const observation = sessions.observeRow(workTarget, noop, {
      onInvalidate: invalidated,
      onEvent: delivered,
    });
    expect(observation.captureReconcile()(workRow)).toMatchObject({ status: "current" });
    const event = (agentId: string, key = "global") =>
      frame("sessions.changed", { agentId, key, reason: "patch" });
    emitEvent(event("main"));
    emitEvent(event("work", "agent:work:unrelated"));
    expect(invalidated).not.toHaveBeenCalled();
    expect(delivered.mock.calls).toEqual([
      [event("main"), { applied: false }],
      [event("work", "agent:work:unrelated"), { applied: false }],
    ]);
    await sessions.refresh({ agentId: "main", force: true });
    expect(invalidated).not.toHaveBeenCalled();
    emitEvent(event("work"));
    expect(invalidated).toHaveBeenCalledTimes(1);
    emitEvent(event("work", "agent:work:unrelated"));
    expect(observation.row).toEqual(workRow);
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(observation.captureReconcile()(workRow)).toMatchObject({ status: "current" });
    expect(delivered).toHaveBeenCalledTimes(4);
    publish(false);
    emitEvent(event("work"));
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(4);
  });

  it.each(["primary", "row", "event", "between frames"] as const)(
    "delivers repeated-payload frames only after descriptor registration (%s)",
    async (source) => {
      const { gateway, emitEvent } = createGatewayHarness(
        createTestGatewayClient(async () => sessionsResult([mainRow], mainRow.updatedAt ?? 0)),
      );
      const sessions = createTestSessionCapability(gateway);
      const target = { key: mainRow.key, agentId: "main" };
      const delivered = vi.fn<SessionRowEventListener>();
      let armed = false;
      let late: SessionRowObservation | undefined;
      const registerFrom = (phase: typeof source) => {
        if (source === phase && armed && !late) {
          late = sessions.observeRow(target, noop, { onEvent: delivered });
        }
      };
      const stop = sessions.subscribe(() => registerFrom("primary"));
      onTestFinished(stop);
      await sessions.refresh({ agentId: "main", force: true });
      const earlyDelivered = vi.fn<SessionRowEventListener>(() => registerFrom("event"));
      sessions.observeRow(target, () => registerFrom("row"), { onEvent: earlyDelivered });
      armed = true;
      const first = frame(
        "sessions.changed",
        { agentId: "main", session: { ...mainRow, updatedAt: 1_000 } },
        1,
      );
      emitEvent(first);
      registerFrom("between frames");
      expect(late?.row).toMatchObject({ sessionId: mainRow.sessionId, updatedAt: 1_000 });
      expect(delivered).not.toHaveBeenCalled();

      const next = { ...first, seq: 2 };
      emitEvent(next);
      expect(earlyDelivered.mock.calls.map(([event]) => event)).toEqual([first, next]);
      expectAdmitted(delivered, next, { updatedAt: 1_000 });
    },
  );

  it.each(["primary", "managed", "supplemental", "event"] as const)(
    "notifies a retired descriptor after its admitted %s successor is published",
    async (source) => {
      const initial: GatewaySessionRow = {
        key: "agent:main:observed-child",
        agentId: "main",
        sessionId: "original-child-session",
        kind: "direct",
        spawnedBy: "agent:main:parent",
        label: "Original child",
        updatedAt: 100,
        archived: false,
      };
      const successor = {
        ...initial,
        sessionId: "successor-child-session",
        label: "Current child",
        updatedAt: 200,
      };
      let listed: GatewaySessionRow[] = [];
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.list") {
          return sessionsResult(listed, 200);
        }
        throw new Error(`Unexpected Gateway request: ${method}`);
      });
      const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      const query = { agentId: "main", search: "child", limit: 1 };
      const managed = source === "managed" ? sessions.observeList(query, noop) : undefined;
      let rebound: SessionRowObservation | undefined;
      const delivered = vi.fn<SessionRowEventListener>();
      const currentDelivered = vi.fn<SessionRowEventListener>();
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.captureReconcile()(initial, undefined, { archivedFilter: "all" })).toBe(true);
      const retirement = vi.fn();
      const target = { key: initial.key, agentId: "main" };
      const changed = vi.fn<(row: GatewaySessionRow | null) => void>();
      const observation = sessions.observeRow(target, changed);
      // This observer stays attached: retirement must not require consumer disposal.
      const captured = sessions.observeRow(target, noop, { onEvent: delivered });
      changed.mockImplementation((row) => {
        const published =
          source === "managed" ? sessions.listSnapshot(query).result : sessions.state.result;
        retirement(
          row,
          observation.isCurrent(),
          observation.row,
          published?.sessions.find((entry) => entry.key === initial.key),
        );
        if (!observation.isCurrent()) {
          observation.dispose();
          rebound = sessions.observeRow(target, noop, { onEvent: currentDelivered });
        }
      });
      expect(observation.row).toMatchObject(initial);
      const old = observation.captureReconcile();
      const retiringFrame = frame(
        "sessions.changed",
        { agentId: "main", reason: "create", session: successor, ts: 200 },
        1,
      );
      listed = [successor];
      if (source === "primary") {
        await sessions.refresh({ agentId: "main", force: true });
      } else if (source === "managed") {
        await managed?.refresh();
      } else if (source === "supplemental") {
        const reconcile = sessions.captureReconcile();
        const result = await sessions.list({ agentId: "main", spawnedBy: initial.spawnedBy });
        expect(reconcile(result?.sessions[0], undefined, { archivedFilter: "all" })).toBe(true);
      } else {
        change(emitEvent, {
          agentId: "main",
          reason: "create",
          session: { ...successor, sessionId: "rejected-child-session", updatedAt: 50 },
          ts: 50,
        });
        expect(observation.isCurrent()).toBe(true);
        expect(observation.row).toMatchObject(initial);
        expect(changed).not.toHaveBeenCalled();
        delivered.mockClear();
        emitEvent(retiringFrame);
      }
      expect(changed).toHaveBeenCalledOnce();
      expect(retirement).toHaveBeenCalledExactlyOnceWith(null, false, null, successor);
      expect(rebound?.row).toMatchObject(successor);
      expect(old({ ...initial, updatedAt: 1_000, label: "Late original child" })).toEqual({
        status: "retired",
      });
      expect(rebound?.row).toMatchObject(successor);
      expect(changed).toHaveBeenCalledOnce();
      expect(captured.isCurrent()).toBe(false);
      expect(captured.row).toBeNull();
      expect(captured.captureReconcile()(initial)).toEqual({ status: "retired" });
      if (source === "event") {
        expect(delivered).toHaveBeenCalledExactlyOnceWith(retiringFrame, { applied: false });
      } else {
        expect(delivered).not.toHaveBeenCalled();
      }
      const next = frame(
        "session.message",
        {
          agentId: "main",
          sessionKey: initial.key,
          session: { ...successor, updatedAt: 201 },
        },
        2,
      );
      emitEvent(next);
      expectAdmitted(currentDelivered, next, { sessionId: successor.sessionId });
      expect(delivered).toHaveBeenCalledTimes(source === "event" ? 1 : 0);
    },
  );

  it("settles a descriptor-only run without changing Main or accepting a stale list", async () => {
    const h = await descriptorOwner(workRow);
    const list = h.holdWorkList();
    expect(h.settleRun({})).toBe(true);
    const expected = { status: "done", hasActiveRun: false, activeRunIds: [], updatedAt: 200 };
    expect(h.observation.row).toMatchObject(expected);
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(h.observation.row);
    h.keepMain();

    expect(h.sessions.state.loading).toBe(true);

    list.response.resolve(sessionsResult([workRow], 200));
    await list.settled;
    expect(h.sessions.state.agentId).toBe("work");
    expect(h.sessions.state.result?.sessions).toEqual([h.observation.row]);
    expect(h.observation.row).toMatchObject(expected);
  });

  it.each(["describe", "list"] as const)(
    "records a same-value terminal confirmation ahead of an already-issued %s read",
    async (source) => {
      const initial: GatewaySessionRow = {
        ...workRow,
        ...terminal,
        abortedLastRun: false,
      };
      const h = await descriptorOwner(initial);
      const list = h.holdWorkList();
      const old = source === "describe" ? h.holdDescribe() : null;
      const before = h.observation.row;
      expect(h.settleRun({ endedAt: 200 })).toBe(false);
      expect(h.observation.row).toBe(before);
      expect(h.changed).not.toHaveBeenCalled();
      h.keepMain();
      expect(h.sessions.state.loading).toBe(true);
      const stale: GatewaySessionRow = {
        ...initial,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["work-run", "other-run"],
        derivedTitle: "Read title",
      };
      if (old) {
        old.response.resolve(stale);
        expect(await old.settled).toMatchObject({ status: "current" });
        h.keepMain();
        expect(h.sessions.state.loading).toBe(true);
      } else {
        list.response.resolve(sessionsResult([stale], 200));
        await list.settled;
      }
      expect(h.observation.row).toMatchObject(terminal);
      if (old) {
        list.response.resolve(sessionsResult([initial], 200));
        await list.settled;
      }
      expect(h.sessions.state.agentId).toBe("work");
      expect(h.sessions.state.result?.sessions[0]).toMatchObject({
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
      });
    },
  );

  it("stages the descriptor before a managed listener reads and disposes it", async () => {
    const initial: GatewaySessionRow = { ...workRow, activeRunIds: ["work-run", "other-run"] };
    const h = await descriptorOwner(initial);
    const query = { agentId: "work", search: "Work", limit: 1 };
    let react = false;
    const delivered: Array<{
      managed: GatewaySessionRow | undefined;
      descriptor: GatewaySessionRow | null;
    }> = [];
    const managed = h.sessions.observeList(query, (snapshot) => {
      if (!react) {
        return;
      }
      delivered.push({ managed: snapshot.result?.sessions[0], descriptor: h.observation.row });
      h.observation.dispose();
    });
    h.disposers.push(managed.dispose);
    const listed = sessionsResult([initial], 200);
    h.reply(listed);
    await managed.refresh();
    const old = h.holdDescribe();
    const list = h.holdWorkList();
    h.changed.mockClear();
    react = true;
    expect(h.settleRun({})).toBe(true);
    expect(delivered).toHaveLength(1);
    const remaining = { hasActiveRun: true, activeRunIds: ["other-run"], status: "running" };
    expect(delivered[0]?.managed).toMatchObject(remaining);
    expect(delivered[0]?.descriptor).toMatchObject(remaining);
    expect(h.observation.isCurrent()).toBe(false);
    expect(h.observation.row).toBeNull();
    h.keepMain();

    old.response.resolve({ ...initial, updatedAt: 500, label: "Retired reply" });
    expect(await old.settled).toEqual({ status: "retired" });
    react = false;
    ownedChange(h.emitEvent, initial, {
      reason: "patch",
      ts: 500,
      updatedAt: 500,
      label: "Live managed row",
    });
    expect(h.sessions.listSnapshot(query).result?.sessions[0]?.label).toBe("Live managed row");
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();
    list.response.resolve(listed);
    await list.settled;
  });

  it.each([
    { key: "global", owner: "work" },
    { key: "global", owner: "main" },
    { key: "unknown", owner: "main" },
  ] as const)(
    "isolates $key facts for $owner even when durable session IDs are equal",
    async ({ key, owner }) => {
      const scoped = owner === "work";
      const initial = {
        ...(scoped ? workRow : mainRow),
        key,
        kind: key,
        sessionId: "shared-session-id",
      };
      const h = await descriptorOwner(
        scoped ? initial : workRow,
        scoped ? { ...mainRow, sessionId: initial.sessionId } : initial,
      );
      const query = scoped
        ? { agentId: "work", search: "Work", limit: 1 }
        : {
            limit: 50,
            includeGlobal: true,
            includeUnknown: true,
            includeDerivedTitles: false,
            includeLastMessage: false,
          };
      const other: GatewaySessionRow = {
        key: "agent:research:ordinary",
        agentId: "research",
        sessionId: "research-ordinary",
        kind: "direct",
        updatedAt: 100,
        label: "Research conversation",
      };
      const rows = scoped ? [initial] : [{ ...initial }, other];
      const managed = h.sessions.observeList(query, noop);
      h.disposers.push(managed.dispose);
      h.reply(sessionsResult(rows, scoped ? 200 : 900));
      await managed.refresh();
      const managedBefore = h.sessions.listSnapshot(query).result;
      h.changed.mockClear();
      const list = scoped ? h.holdWorkList() : null;
      const before = h.observation.row;
      const unchanged = () => {
        expect(h.sessions.listSnapshot(query).result).toBe(managedBefore);
        expect(h.sessions.listSnapshot(query).result?.sessions).toEqual(rows);
        expect(h.observation.row).toBe(before);
        expect(h.changed).not.toHaveBeenCalled();
        h.keepMain();
      };
      ownedChange(h.emitEvent, initial, {
        agentId: "research",
        reason: "patch",
        ts: 1_000,
        updatedAt: 1_000,
        label: scoped ? "Foreign descriptor" : "Foreign sentinel",
        status: scoped ? "done" : "running",
        hasActiveRun: !scoped,
        activeRunIds: scoped ? [] : ["research-run"],
      });
      unchanged();
      ownedChange(h.emitEvent, initial, {
        agentId: "research",
        reason: "delete",
        ts: scoped ? 1_100 : 1_050,
      });
      unchanged();
      const owned = {
        ...initial,
        updatedAt: scoped ? 250 : 1_100,
        label: scoped ? "Owned descriptor" : "Owned sentinel",
      };
      ownedChange(h.emitEvent, initial, {
        agentId: owner,
        reason: "patch",
        ts: owned.updatedAt,
        updatedAt: owned.updatedAt,
        label: owned.label,
      });
      expect(h.sessions.listSnapshot(query).result?.sessions).toEqual(
        scoped ? [owned] : [owned, other],
      );
      if (list) {
        expect(h.observation.row).toMatchObject(owned);
        expect(h.changed).toHaveBeenCalledOnce();
        h.keepMain();
        list.response.resolve(sessionsResult([initial], 200));
        await list.settled;
        expect(h.sessions.state.result?.sessions[0]?.label).toBe("Owned descriptor");
        ownedChange(h.emitEvent, initial, {
          reason: "delete",
          ts: 1_200,
        });
        expect(h.sessions.listSnapshot(query).result?.sessions).toEqual([]);
        expect(h.observation.row).toBeNull();
        expect(h.sessions.state.agentId).toBe("work");
        expect(h.sessions.state.result?.sessions).toEqual([]);
      }
    },
  );

  it.each(["delete", "disconnect"] as const)(
    "keeps a descriptor absent after %s when an earlier read finishes",
    async (retirement) => {
      const h = await descriptorOwner(workRow);
      let observation = h.observation;
      if (retirement === "delete") {
        observation.dispose();
        observation = h.sessions.observeRow(workTarget, noop);
        h.disposers.push(observation.dispose);
        expect(observation.row).toBeNull();
      }
      const earlier = h.holdDescribe(observation);
      const query = { agentId: "work", search: "Work", limit: 1 };
      if (retirement === "delete") {
        const managed = h.sessions.observeList(query, noop);
        h.disposers.push(managed.dispose);
        h.reply(sessionsResult([workRow], 200));
        await managed.refresh();
        expect(observation.row).toMatchObject(workRow);
        ownedChange(h.emitEvent, workRow, {
          reason: "delete",
          ts: 300,
        });
        expect(h.sessions.listSnapshot(query).result?.sessions).toEqual([]);
        h.keepMain();
      } else {
        h.publish(false);
        expect(observation.isCurrent()).toBe(false);
        h.changed.mockClear();
      }
      expect(observation.row).toBeNull();
      earlier.response.resolve({
        ...workRow,
        updatedAt: retirement === "delete" ? 1_000 : 500,
        label: retirement === "delete" ? "Deleted late reply" : "Old connection",
      });
      const result = await earlier.settled;
      expect(observation.row).toBeNull();
      if (retirement === "delete") {
        h.keepMain();
      } else {
        expect(result).toEqual({ status: "retired" });
        expect(h.changed).not.toHaveBeenCalled();
      }
    },
  );
});
