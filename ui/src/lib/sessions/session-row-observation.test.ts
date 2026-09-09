// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { SessionRowObservation } from "./index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

type DescribeResult = { session: GatewaySessionRow | null };

const mainRow: GatewaySessionRow = {
  key: "global",
  agentId: "main",
  sessionId: "main-global-session",
  kind: "global",
  updatedAt: 900,
  label: "Main roster",
  archived: false,
  status: "done",
  hasActiveRun: false,
  activeRunIds: [],
};
const workRow: GatewaySessionRow = {
  key: "global",
  agentId: "work",
  sessionId: "work-global-session",
  kind: "global",
  updatedAt: 200,
  label: "Work descriptor",
  archived: false,
  status: "running",
  hasActiveRun: true,
  activeRunIds: ["work-run"],
};

async function descriptorOwner(initial: GatewaySessionRow, primary = mainRow) {
  vi.useFakeTimers();
  const replies: Array<{ method: string; params: Record<string, unknown>; result: unknown }> = [];
  const requestErrors: unknown[] = [];
  const finishReplies: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  const disposers: Array<() => void> = [];
  const client = createTestGatewayClient(async (method, params) => {
    try {
      const reply = replies.shift();
      if (!reply) {
        throw new Error(`Unexpected Gateway request: ${method}`);
      }
      expect(method).toBe(reply.method);
      expect(params).toMatchObject(reply.params);
      return await reply.result;
    } catch (error) {
      requestErrors.push(error);
      throw error;
    }
  });
  const { gateway, emitEvent, publish } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.push(
      promise.then(
        () => undefined,
        () => undefined,
      ),
    );
    return promise;
  };
  const reply = (method: string, params: Record<string, unknown>, result: unknown) => {
    replies.push({ method, params, result });
  };
  const hold = <T>(method: string, params: Record<string, unknown>, fallback: T) => {
    const deferred = createDeferred<T>();
    reply(method, params, deferred.promise);
    finishReplies.push(() => deferred.resolve(fallback));
    return deferred;
  };
  const read = (observation: SessionRowObservation) => {
    const reconcile = observation.captureReconcile();
    return track(
      client
        .request<DescribeResult>("sessions.describe", { key: "global", agentId: "work" })
        .then((result) => reconcile(result.session ?? undefined)),
    );
  };
  onTestFinished(async () => {
    for (const dispose of disposers) {
      dispose();
    }
    sessions.dispose();
    for (const finish of finishReplies) {
      finish();
    }
    await Promise.all(pending);
    vi.useRealTimers();
    // Request errors can be handled by the capability; still fail the fixture.
    expect(requestErrors).toEqual([]);
    expect(replies).toEqual([]);
  });

  reply("sessions.list", { agentId: "main" }, sessionsResult([primary], 900));
  await sessions.refresh({ agentId: "main", force: true });
  expect(sessions.state.result?.sessions).toEqual([primary]);
  expect(sessions.state.agentId).toBe("main");
  const primaryResult = sessions.state.result;
  const revision = sessions.canonicalListRevision;
  const changed = vi.fn<(row: GatewaySessionRow | null) => void>();
  const observation = sessions.observeRow({ key: "global", agentId: "work" }, changed);
  disposers.push(observation.dispose);
  expect(observation.row).toBeNull();
  reply("sessions.describe", { key: "global", agentId: "work" }, { session: initial });
  expect(await read(observation)).toMatchObject({ status: "current", row: initial });
  changed.mockClear();

  const keepMain = () => {
    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.state.result?.sessions).toBe(primaryResult?.sessions);
    expect(sessions.state.result?.defaults).toBe(primaryResult?.defaults);
    expect(sessions.state.agentId).toBe("main");
    expect(sessions.canonicalListRevision).toBe(revision);
  };
  const holdWorkList = () => {
    const result = sessionsResult([initial], 200);
    const response = hold("sessions.list", { agentId: "work" }, result);
    const settled = track(sessions.refresh({ agentId: "work", force: true }));
    expect(sessions.state.loading).toBe(true);
    keepMain();
    return { response, settled };
  };
  const holdDescribe = (target = observation) => {
    const response = hold<DescribeResult>(
      "sessions.describe",
      { key: "global", agentId: "work" },
      { session: initial },
    );
    return { response, settled: read(target) };
  };
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
  };
}

describe("session row observations", () => {
  it.each(["primary", "managed", "supplemental", "event"] as const)(
    "notifies a retired descriptor after its admitted %s successor is published",
    async (source) => {
      vi.useFakeTimers();
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
      const managed =
        source === "managed" ? sessions.observeList(query, () => undefined) : undefined;
      let rebound: SessionRowObservation | undefined;
      onTestFinished(() => {
        rebound?.dispose();
        managed?.dispose();
        sessions.dispose();
        vi.useRealTimers();
      });
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.captureReconcile()(initial, undefined, { archivedFilter: "all" })).toBe(true);
      const deliveries: Array<{
        row: GatewaySessionRow | null;
        current: boolean;
        held: GatewaySessionRow | null;
        published: GatewaySessionRow | undefined;
      }> = [];
      const target = { key: initial.key, agentId: "main" };
      const changed = vi.fn<(row: GatewaySessionRow | null) => void>();
      const observation = sessions.observeRow(target, changed);
      onTestFinished(observation.dispose);
      changed.mockImplementation((row) => {
        const published =
          source === "managed" ? sessions.listSnapshot(query).result : sessions.state.result;
        deliveries.push({
          row,
          current: observation.isCurrent(),
          held: observation.row,
          published: published?.sessions.find((entry) => entry.key === initial.key),
        });
        if (!observation.isCurrent()) {
          observation.dispose();
          rebound = sessions.observeRow(target, () => undefined);
        }
      });
      expect(observation.row).toMatchObject(initial);
      const old = observation.captureReconcile();
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
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: "create",
            session: { ...successor, sessionId: "rejected-child-session", updatedAt: 50 },
            ts: 50,
          },
        });
        expect(observation.isCurrent()).toBe(true);
        expect(observation.row).toMatchObject(initial);
        expect(deliveries).toEqual([]);
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { agentId: "main", reason: "create", session: successor, ts: 200 },
        });
      }
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        row: null,
        current: false,
        held: null,
        published: successor,
      });
      expect(rebound?.row).toMatchObject(successor);
      expect(old({ ...initial, updatedAt: 1_000, label: "Late original child" })).toEqual({
        status: "retired",
      });
      expect(rebound?.row).toMatchObject(successor);
      expect(deliveries).toHaveLength(1);
    },
  );

  it("keeps a descriptor lease when a different-ID event has no admitted roster member", async () => {
    const h = await descriptorOwner(workRow);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        agentId: "work",
        reason: "create",
        session: { ...workRow, sessionId: "unadmitted-work-session", updatedAt: 1_000 },
        ts: 1_000,
      },
    });
    expect(h.observation.isCurrent()).toBe(true);
    expect(h.observation.row).toMatchObject(workRow);
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();
  });

  it("seeds a live descriptor past an unobserved primary incarnation", async () => {
    const h = await descriptorOwner(workRow);
    const unobserved = { ...workRow, sessionId: "unobserved-work-session", updatedAt: 100 };
    expect(
      h.sessions.reconcile(unobserved, undefined, {
        resultAgentId: "work",
        selectedGlobalAgentId: "work",
        archivedFilter: "all",
      }),
    ).toBe(true);
    expect(h.sessions.state.result?.sessions).toEqual([unobserved]);
    expect(h.observation.row).toMatchObject(workRow);
    const observation = h.sessions.observeRow({ key: "global", agentId: "work" }, () => undefined);
    h.disposers.push(observation.dispose);
    expect(observation.row).toMatchObject(workRow);
  });

  it("settles the descriptor-only run without donating the preceding run's timing or changing Main", async () => {
    const initial: GatewaySessionRow = {
      ...workRow,
      lastRunId: "previous-run",
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
      lastRunError: "Previous run failed",
      abortedLastRun: true,
    };
    const h = await descriptorOwner(initial);
    const list = h.holdWorkList();
    const old = h.holdDescribe();
    expect(
      h.sessions.reconcileRunTerminal({
        sessionKeys: ["global"],
        agentId: "work",
        runId: "work-run",
        status: "timeout",
        endedAt: 400,
        errorMessage: "Current run\ntimed out",
      }),
    ).toBe(true);
    const expected = {
      key: "global",
      agentId: "work",
      sessionId: initial.sessionId,
      status: "timeout",
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: "work-run",
      endedAt: 400,
      abortedLastRun: false,
      lastRunError: "Current run timed out",
    };
    expect(h.observation.row).toMatchObject({ ...expected, updatedAt: 200 });
    expect(h.observation.row?.startedAt).toBeUndefined();
    expect(h.observation.row?.runtimeMs).toBeUndefined();
    expect(h.changed).toHaveBeenCalledOnce();
    expect(h.changed).toHaveBeenLastCalledWith(h.observation.row);
    h.keepMain();

    old.response.resolve({ session: { ...initial, updatedAt: 250, derivedTitle: "Read title" } });
    expect(await old.settled).toMatchObject({ status: "current", row: expected });
    expect(h.observation.row).toMatchObject({
      ...expected,
      updatedAt: 250,
      derivedTitle: "Read title",
    });
    expect(h.observation.row?.startedAt).toBeUndefined();
    expect(h.observation.row?.runtimeMs).toBeUndefined();
    h.keepMain();
    expect(h.sessions.state.loading).toBe(true);

    list.response.resolve(sessionsResult([initial], 200));
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
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "work-run",
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
        abortedLastRun: false,
      };
      const h = await descriptorOwner(initial);
      const list = h.holdWorkList();
      const old = source === "describe" ? h.holdDescribe() : null;
      const before = h.observation.row;
      expect(
        h.sessions.reconcileRunTerminal({
          sessionKeys: ["global"],
          agentId: "work",
          runId: "work-run",
          status: "done",
          endedAt: 200,
        }),
      ).toBe(false);
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
        old.response.resolve({ session: stale });
        expect(await old.settled).toMatchObject({ status: "current" });
        h.keepMain();
        expect(h.sessions.state.loading).toBe(true);
      } else {
        list.response.resolve(sessionsResult([stale], 200));
        await list.settled;
      }
      expect(h.observation.row).toMatchObject({
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        derivedTitle: "Read title",
        lastRunId: "work-run",
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
      });
      if (old) {
        list.response.resolve(sessionsResult([initial], 200));
        await list.settled;
      }
      expect(h.sessions.state.agentId).toBe("work");
      expect(h.sessions.state.result?.sessions[0]).toMatchObject({
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        derivedTitle: "Read title",
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
    const listed: SessionsListResult = {
      ...sessionsResult([initial], 200),
      totalCount: 12,
      hasMore: true,
      nextOffset: 1,
    };
    h.reply("sessions.list", query, listed);
    await managed.refresh();
    const old = h.holdDescribe();
    const list = h.holdWorkList();
    h.changed.mockClear();
    react = true;
    expect(
      h.sessions.reconcileRunTerminal({
        sessionKeys: ["global"],
        agentId: "work",
        runId: "work-run",
        status: "done",
        endedAt: 400,
      }),
    ).toBe(true);
    expect(delivered).toHaveLength(1);
    const remaining = { hasActiveRun: true, activeRunIds: ["other-run"], status: "running" };
    expect(delivered[0]?.managed).toMatchObject(remaining);
    expect(delivered[0]?.descriptor).toMatchObject(remaining);
    expect(h.sessions.listSnapshot(query).result).toMatchObject({
      count: 1,
      totalCount: 12,
      hasMore: true,
      nextOffset: 1,
    });
    expect(h.observation.isCurrent()).toBe(false);
    expect(h.observation.row).toBeNull();
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();

    old.response.resolve({ session: { ...initial, updatedAt: 500, label: "Retired reply" } });
    expect(await old.settled).toEqual({ status: "retired" });
    expect(h.changed).not.toHaveBeenCalled();
    react = false;
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "work",
        sessionId: initial.sessionId,
        reason: "patch",
        ts: 500,
        updatedAt: 500,
        label: "Live managed row",
      },
    });
    expect(h.sessions.listSnapshot(query).result?.sessions[0]?.label).toBe("Live managed row");
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();
    list.response.resolve(listed);
    await list.settled;
  });

  it("keeps a foreign owner's global facts separate even when durable session IDs are equal", async () => {
    const initial = { ...workRow, sessionId: "shared-session-id" };
    const h = await descriptorOwner(initial, { ...mainRow, sessionId: initial.sessionId });
    const query = { agentId: "work", search: "Work", limit: 1 };
    const managed = h.sessions.observeList(query, () => undefined);
    h.disposers.push(managed.dispose);
    h.reply("sessions.list", query, sessionsResult([initial], 200));
    await managed.refresh();
    const managedBefore = h.sessions.listSnapshot(query).result;
    h.changed.mockClear();
    const list = h.holdWorkList();
    const before = h.observation.row;
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "research",
        sessionId: initial.sessionId,
        reason: "patch",
        ts: 1_000,
        updatedAt: 1_000,
        label: "Foreign descriptor",
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
      },
    });
    expect(h.observation.row).toBe(before);
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "research",
        sessionId: initial.sessionId,
        reason: "delete",
        ts: 1_100,
      },
    });
    expect.soft(h.sessions.listSnapshot(query).result).toBe(managedBefore);
    expect.soft(h.sessions.listSnapshot(query).result?.sessions).toMatchObject([initial]);
    expect(h.observation.row).toBe(before);
    expect(h.changed).not.toHaveBeenCalled();
    h.keepMain();
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "work",
        sessionId: initial.sessionId,
        reason: "patch",
        ts: 250,
        updatedAt: 250,
        label: "Owned descriptor",
      },
    });
    expect(h.observation.row).toMatchObject({
      ...initial,
      updatedAt: 250,
      label: "Owned descriptor",
    });
    expect(h.changed).toHaveBeenCalledOnce();
    expect.soft(h.sessions.listSnapshot(query).result?.sessions[0]?.label).toBe("Owned descriptor");
    h.keepMain();
    list.response.resolve(sessionsResult([initial], 200));
    await list.settled;
    expect(h.sessions.state.result?.sessions[0]?.label).toBe("Owned descriptor");
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "work",
        sessionId: initial.sessionId,
        reason: "delete",
        ts: 1_200,
      },
    });
    expect(h.sessions.listSnapshot(query).result?.sessions).toEqual([]);
    expect(h.observation.row).toBeNull();
    expect(h.sessions.state.agentId).toBe("work");
    expect(h.sessions.state.result?.sessions).toEqual([]);
  });

  it.each(["global", "unknown"] as const)(
    "keeps the projected %s owner in a normal All-agents query",
    async (key) => {
      const primary = { ...mainRow, key, kind: key, sessionId: "shared-sentinel-session" };
      const h = await descriptorOwner(workRow, primary);
      const query = {
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
      const managed = h.sessions.observeList(query, () => undefined);
      h.disposers.push(managed.dispose);
      h.reply(
        "sessions.list",
        { limit: 50, includeGlobal: true, includeUnknown: true },
        sessionsResult([primary, other], 900),
      );
      await managed.refresh();
      const before = h.sessions.listSnapshot(query).result;
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: key,
          agentId: "research",
          sessionId: primary.sessionId,
          reason: "patch",
          ts: 1_000,
          updatedAt: 1_000,
          label: "Foreign sentinel",
          hasActiveRun: true,
          status: "running",
          activeRunIds: ["research-run"],
        },
      });
      expect.soft(h.sessions.listSnapshot(query).result).toBe(before);
      expect.soft(h.sessions.listSnapshot(query).result?.sessions).toEqual([primary, other]);
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: key,
          agentId: "research",
          sessionId: primary.sessionId,
          reason: "delete",
          ts: 1_050,
        },
      });
      expect(h.sessions.listSnapshot(query).result).toBe(before);
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: key,
          agentId: "main",
          sessionId: primary.sessionId,
          reason: "patch",
          ts: 1_100,
          updatedAt: 1_100,
          label: "Owned sentinel",
        },
      });
      expect(h.sessions.listSnapshot(query).result?.sessions).toEqual([
        { ...primary, updatedAt: 1_100, label: "Owned sentinel" },
        other,
      ]);
    },
  );

  it("keeps a deleted descriptor absent when its earlier empty read finishes", async () => {
    const h = await descriptorOwner(workRow);
    h.observation.dispose();
    const observation = h.sessions.observeRow({ key: "global", agentId: "work" }, () => undefined);
    h.disposers.push(observation.dispose);
    expect(observation.row).toBeNull();
    const earlier = h.holdDescribe(observation);
    const query = { agentId: "work", search: "Work", limit: 1 };
    const managed = h.sessions.observeList(query, () => undefined);
    h.disposers.push(managed.dispose);
    h.reply("sessions.list", query, sessionsResult([workRow], 200));
    await managed.refresh();
    expect(observation.row).toMatchObject(workRow);

    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "work",
        sessionId: workRow.sessionId,
        reason: "delete",
        ts: 300,
      },
    });
    expect(observation.row).toBeNull();
    expect(h.sessions.listSnapshot(query).result?.sessions).toEqual([]);
    h.keepMain();
    earlier.response.resolve({
      session: { ...workRow, updatedAt: 1_000, label: "Deleted late reply" },
    });
    await earlier.settled;
    expect(observation.row).toBeNull();
    h.keepMain();
  });

  it("retires a descriptor receipt when its Gateway connection ends", async () => {
    const h = await descriptorOwner(workRow);
    const old = h.holdDescribe();
    h.publish(false);
    expect(h.observation.isCurrent()).toBe(false);
    expect(h.observation.row).toBeNull();
    h.changed.mockClear();
    old.response.resolve({ session: { ...workRow, updatedAt: 500, label: "Old connection" } });
    expect(await old.settled).toEqual({ status: "retired" });
    expect(h.observation.row).toBeNull();
    expect(h.changed).not.toHaveBeenCalled();
  });
});
