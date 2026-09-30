// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { reconcileSessionRunTerminal, type SessionRunTerminal } from "./session-run-terminal.ts";

const mainKey = "agent:main:main";
const row = (key = mainKey, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt: 1,
  ...fields,
});
const emptyList = () => sessionsResult([], 2);
const subscribed = () => ({ subscribed: true });

function sessionHarness(
  routes: Record<string, (params?: unknown) => unknown>,
  featureMethods?: string[],
  sessionKey = mainKey,
) {
  const request = createGatewayRequestMock(async (method, params) => {
    const handler = routes[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return await handler(params);
  });
  const harness = createGatewayHarness(createTestGatewayClient(request), featureMethods);
  harness.gateway.snapshot.sessionKey = sessionKey;
  return { ...harness, request, sessions: createTestSessionCapability(harness.gateway) };
}

function changed(key: string) {
  return {
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      reason: "create",
      key,
      kind: "direct",
      updatedAt: 2,
      sessionId: "hidden-session",
      label: "Hidden",
    },
  } as const;
}

afterEach(() => vi.useRealTimers());

it("shares confirmed archive visibility after Gateway events", async () => {
  const key = "agent:main:archive-from-agent";
  const held = row(key, { sessionId: "archive-session" });
  const { sessions, emitEvent } = sessionHarness({
    "sessions.list": () => sessionsResult([held], 1),
  });
  const reconcile = (archived: boolean, updatedAt: number) =>
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { ...held, sessionKey: key, reason: "patch", archived, updatedAt },
    });
  await sessions.refresh({ agentId: "main", force: true });
  reconcile(true, 2);
  expect(sessions.archiveVisibility(key)).toBe("archived");
  await sessions.refresh({ agentId: "main", force: true });
  expect(sessions.archiveVisibility(key)).toBe("archived");
  reconcile(false, 3);
  expect(sessions.archiveVisibility(key)).toBeUndefined();
  sessions.dispose();
});

it("automatically retries an explicitly retryable group catalog failure", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { sessions } = sessionHarness(
    {
      "sessions.groups.list": () => {
        if (++calls === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "temporary catalog failure",
            retryable: true,
            retryAfterMs: 100,
          });
        }
        return { groups: [{ name: "Recovered" }], sectionOrder: ["work", "category:Recovered"] };
      },
    },
    ["sessions.groups.list"],
  );
  await sessions.groupsLoad();
  await vi.advanceTimersByTimeAsync(100);
  expect(sessions.state.groups).toEqual(["Recovered"]);
  expect(sessions.state.sectionOrder).toEqual(["work", "category:Recovered"]);
  expect(calls).toBe(2);
  sessions.dispose();
});

it("publishes state.error when replacing the group catalog is rejected", async () => {
  const { sessions } = sessionHarness(
    {
      "sessions.groups.put": () => {
        throw new Error("group catalog rejected");
      },
    },
    ["sessions.groups.put"],
  );
  await expect(sessions.groupsPut(["Alpha"])).rejects.toThrow("group catalog rejected");
  expect(sessions.state.error).toBe("group catalog rejected");
  sessions.dispose();
});

it("reports a group catalog replacement as stale after a same-client reconnect", async () => {
  const replaced = createDeferred<{ groups: Array<{ name: string }> }>();
  const { sessions, publish } = sessionHarness(
    {
      "sessions.groups.put": () => replaced.promise,
      "sessions.subscribe": subscribed,
      "sessions.list": emptyList,
    },
    ["sessions.groups.put"],
  );
  const operation = sessions.groupsPut(["Alpha"]);
  publish(false);
  publish(true);
  replaced.resolve({ groups: [{ name: "Alpha" }] });
  await expect(operation).resolves.toBe("stale");
  expect(sessions.state.groups).toEqual([]);
  expect(sessions.state.error).toBeNull();
  sessions.dispose();
});

it("keeps a confirmed group rename completed when its row refresh outlives the connection", async () => {
  const refreshed = createDeferred<SessionsListResult>();
  const { sessions, publish, request } = sessionHarness(
    {
      "sessions.groups.rename": () => ({ groups: [{ name: "Beta" }] }),
      "sessions.list": () => refreshed.promise,
    },
    ["sessions.groups.rename"],
  );
  const mutation = sessions.groupsRename("Alpha", "Beta");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("sessions.list", expect.any(Object)),
  );
  publish(false);
  refreshed.resolve(emptyList());
  await expect(mutation).resolves.toBe("completed");
  sessions.dispose();
});

it("ignores an older group load failure after an event-driven load succeeds", async () => {
  const first = createDeferred<{ groups: Array<{ name: string }> }>();
  const current = createDeferred<{ groups: Array<{ name: string }> }>();
  let calls = 0;
  const { sessions, emitEvent } = sessionHarness(
    {
      "sessions.groups.list": () => (++calls === 1 ? first.promise : current.promise),
      "sessions.list": () => sessionsResult([], 1),
    },
    ["sessions.groups.list"],
  );
  const firstLoad = sessions.groupsLoad();
  await waitForFast(() => expect(calls).toBe(1));
  emitEvent({ type: "event", event: "sessions.changed", payload: { reason: "groups" } });
  await waitForFast(() => expect(calls).toBe(2));
  current.resolve({ groups: [{ name: "Current" }] });
  await waitForFast(() => expect(sessions.state.groups).toEqual(["Current"]));
  first.reject(new Error("stale catalog failure"));
  await firstLoad;
  await sessions.groupsLoad();
  expect(calls).toBe(2);
  expect(sessions.state.groups).toEqual(["Current"]);
  sessions.dispose();
});

it("excludes lifecycle no-ops from batch deletion results", async () => {
  const rejectedKey = "agent:main:rejected";
  const keptKey = "agent:main:kept";
  const deletedKey = "agent:main:deleted";
  const error = new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: `Session ${rejectedKey} changed before deletion. Retry.`,
  });
  const { sessions, request } = sessionHarness({
    "sessions.delete": (params) => {
      const key = asOptionalRecord(params)?.key;
      if (key === rejectedKey) {
        throw error;
      }
      return { ok: true, deleted: key === deletedKey };
    },
    "sessions.list": () => sessionsResult([row(keptKey)], 2),
  });
  const deletedSnapshots: string[][] = [];
  const unsubscribe = sessions.subscribe((next) =>
    deletedSnapshots.push(next.deletedSessions.map((target) => target.key)),
  );
  await expect(
    sessions.deleteMany([
      { key: rejectedKey },
      { key: keptKey, expectedSessionId: "kept-generation" },
      { key: deletedKey, archivedOnly: true },
    ]),
  ).resolves.toEqual({
    deleted: [deletedKey],
    errors: [{ target: { key: rejectedKey }, error }],
    preservedWorktrees: [],
  });
  expect(deletedSnapshots.some((keys) => keys.includes(deletedKey))).toBe(true);
  expect(deletedSnapshots.some((keys) => keys.includes(keptKey))).toBe(false);
  expect(request).toHaveBeenCalledTimes(4);
  expect(request).toHaveBeenCalledWith(
    "sessions.delete",
    { key: deletedKey, deleteTranscript: true, archivedOnly: true },
    { timeoutMs: 10 * 60_000 },
  );
  expect(request).toHaveBeenCalledWith(
    "sessions.delete",
    { key: keptKey, deleteTranscript: true, expectedSessionId: "kept-generation" },
    { timeoutMs: 10 * 60_000 },
  );
  unsubscribe();
  sessions.dispose();
});

it("creates a session while a list refresh is in flight", async () => {
  const pending = createDeferred<SessionsListResult>();
  const key = "agent:main:created";
  let calls = 0;
  const { sessions, request } = sessionHarness({
    "sessions.list": () =>
      ++calls === 1 ? pending.promise : sessionsResult([row(key, { updatedAt: 2 })], 2),
    "sessions.create": () => ({ key }),
  });
  const refresh = sessions.refresh({ force: true });
  expect(sessions.state.loading).toBe(true);
  const created = sessions.create({ agentId: "main" });
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("sessions.create", { agentId: "main" }),
  );
  pending.resolve(sessionsResult([], 1));
  await expect(created).resolves.toBe(key);
  await refresh;
  expect(calls).toBe(2);
  expect(sessions.state.result?.sessions[0]?.key).toBe(key);
  sessions.dispose();
});

it("reports a reset as stale when its connection epoch retires", async () => {
  const pending = createDeferred<unknown>();
  const { sessions, publish } = sessionHarness({
    "sessions.reset": () => pending.promise,
    "sessions.subscribe": subscribed,
    "sessions.list": emptyList,
  });
  const reset = sessions.reset(mainKey);
  publish(false);
  publish(true);
  pending.resolve({});
  await expect(reset).resolves.toBe("uncertain");
  sessions.dispose();
});

it("reports a same-connection reset rejection as uncertain", async () => {
  const { sessions } = sessionHarness({
    "sessions.reset": () => {
      throw new Error("post-commit lifecycle failed");
    },
    "sessions.subscribe": subscribed,
    "sessions.list": emptyList,
  });
  await expect(sessions.reset(mainKey)).resolves.toBe("uncertain");
  expect(sessions.state.error).toContain("post-commit lifecycle failed");
  sessions.dispose();
});

it("keeps background hydration non-blocking and retains an omitted selected row", async () => {
  const pending = createDeferred<SessionsListResult>();
  const key = "agent:main:oldest";
  let calls = 0;
  const { sessions } = sessionHarness(
    {
      "sessions.list": () =>
        ++calls === 1 ? sessionsResult([row(key, { label: "Oldest" })], 1) : pending.promise,
    },
    undefined,
    key,
  );
  await sessions.refresh({ agentId: "main", force: true });
  const loading: boolean[] = [];
  const stop = sessions.subscribe((state) => loading.push(state.loading));
  const hydration = sessions.refresh({ agentId: "main", backgroundHydrate: true, force: true });
  expect(sessions.state.loading).toBe(false);
  pending.resolve(emptyList());
  await hydration;
  expect(loading).not.toContain(true);
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key, label: "Oldest" }),
  ]);
  stop();
  sessions.dispose();
});

it("publishes terminal run state to shared session subscribers", async () => {
  const active = (updatedAt: number, activeRunIds?: string[]) =>
    row(mainKey, {
      updatedAt,
      hasActiveRun: true,
      ...(activeRunIds ? { activeRunIds } : {}),
      status: "running",
      startedAt: updatedAt * 100,
    });
  const { sessions } = sessionHarness({
    "sessions.list": () => sessionsResult([active(1, ["run-1"])], 1),
  });
  await sessions.refresh({ agentId: "main", force: true });
  const terminal = (
    runId: string | undefined,
    status: SessionRunTerminal["status"],
    endedAt: number,
    errorMessage?: string,
  ) =>
    sessions.reconcileRunTerminal({ sessionKeys: ["main"], runId, status, endedAt, errorMessage });
  const current = () => sessions.state.result?.sessions[0];
  expect(
    terminal(
      "run-1",
      "failed",
      160,
      `Provider failed.\npassword=synthetic-password\n${"x".repeat(180)}`,
    ),
  ).toBe(true);
  const lastRunError = `Provider failed. password=[redacted] ${"x".repeat(123)}`;
  expect(current()).toMatchObject({
    key: mainKey,
    hasActiveRun: false,
    activeRunIds: [],
    status: "failed",
    lastRunError,
    endedAt: 160,
    runtimeMs: 60,
  });
  expect(terminal("run-1", "failed", 160)).toBe(false);
  expect(current()?.lastRunError).toBe(lastRunError);
  expect(sessions.reconcile({ ...active(2, ["run-2"]), lastRunError })).toBe(true);
  expect(terminal("run-1", "done", 260)).toBe(false);
  expect(current()).toMatchObject({
    hasActiveRun: true,
    activeRunIds: ["run-2"],
    status: "running",
    lastRunError,
  });
  expect(terminal("run-2", "done", 260)).toBe(true);
  expect(current()).toMatchObject({ hasActiveRun: false, status: "done" });
  expect(current()?.lastRunError).toBeUndefined();
  expect(sessions.reconcile(active(3))).toBe(true);
  expect(terminal("run-1", "done", 360)).toBe(false);
  expect(current()).toMatchObject({ hasActiveRun: true, status: "running" });
  expect(terminal(undefined, "done", 360)).toBe(false);
  sessions.dispose();
});

it("publishes remote deletion before refreshing the canonical list", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<SessionsListResult>();
  let calls = 0;
  const { sessions, emitEvent, request } = sessionHarness({
    "sessions.list": () =>
      ++calls === 1
        ? sessionsResult([row(mainKey, { sessionId: "deleted-generation" })], 1)
        : pending.promise,
  });
  await sessions.refresh({ force: true });
  const deleted: string[][] = [];
  sessions.subscribe((next) => deleted.push(next.deletedSessions.map((target) => target.key)));
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: mainKey, sessionId: "deleted-generation", reason: "delete" },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(deleted.some((keys) => keys.includes(mainKey))).toBe(true);
  pending.resolve(emptyList());
  await vi.advanceTimersByTimeAsync(0);
  expect(sessions.state.loading).toBe(false);
  sessions.dispose();
});

it("refreshes broad lists when the client omits the server-side window limit", async () => {
  vi.useFakeTimers();
  const hiddenKey = "agent:local:hidden";
  const { sessions, emitEvent, request } = sessionHarness({
    "sessions.list": () => sessionsResult([row()], 1),
  });
  await sessions.refresh({ configuredAgentsOnly: false, force: true, limit: 0 });
  const params = request.mock.calls[0]?.[1];
  expect(params).toEqual(
    expect.objectContaining({
      configuredAgentsOnly: false,
      includeGlobal: true,
      includeUnknown: true,
    }),
  );
  expect(params).not.toHaveProperty("limit");
  emitEvent(changed(hiddenKey));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(sessions.state.result?.sessions.map((entry) => entry.key)).not.toContain(hiddenKey);
  sessions.dispose();
});

it("ignores stale archive state after a newer unarchive via Gateway events", async () => {
  const held = row(mainKey, { sessionId: "main-session", updatedAt: 30, archived: false });
  const { sessions, emitEvent } = sessionHarness({
    "sessions.list": () => sessionsResult([held], 30),
  });
  await sessions.refresh({ agentId: "main", force: true });
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      ...held,
      sessionKey: mainKey,
      updatedAt: 20,
      archived: true,
      archivedAt: 20,
      reason: "update",
    },
  });
  expect(sessions.state.result?.sessions.find((entry) => entry.key === mainKey)).toMatchObject({
    archived: false,
    updatedAt: 30,
  });
  sessions.dispose();
});

it("advances the canonical list revision only for sessions.list publications", async () => {
  const { sessions } = sessionHarness({
    "sessions.list": () => sessionsResult([row("agent:main:listed", { updatedAt: 2 })], 2),
  });
  expect(sessions.canonicalListRevision).toBe(0);
  sessions.reconcile(row("agent:main:startup"), {
    modelProvider: null,
    model: null,
    contextTokens: null,
  });
  expect(sessions.canonicalListRevision).toBe(0);
  await sessions.refresh({ force: true });
  expect(sessions.canonicalListRevision).toBe(1);
  expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:listed");
  sessions.dispose();
});

it("starts a fresh list epoch when the same client reconnects", async () => {
  const stale = createDeferred<SessionsListResult>();
  const current = createDeferred<SessionsListResult>();
  let calls = 0;
  const { sessions, publish } = sessionHarness({
    "sessions.subscribe": subscribed,
    "sessions.list": () => (++calls === 1 ? stale.promise : current.promise),
  });
  const staleRefresh = sessions.refresh({ force: true });
  publish(false);
  publish(true);
  await waitForFast(() => expect(calls).toBe(2));
  stale.resolve(sessionsResult([row("stale")], 1));
  await staleRefresh;
  expect(sessions.state.result).toBeNull();
  current.resolve(sessionsResult([row("current", { updatedAt: 2 })], 2));
  await waitForFast(() => expect(sessions.state.result?.sessions[0]?.key).toBe("current"));
  sessions.dispose();
});

it("does not probe for a group catalog when the method is explicitly absent", async () => {
  const { sessions, request } = sessionHarness({}, []);
  await sessions.groupsLoad();
  await sessions.groupsLoad();
  expect(request).not.toHaveBeenCalled();
  expect(sessions.state.groups).toEqual([]);
  sessions.dispose();
});

it("preserves registry-active terminal rows without matching run identity", () => {
  const result = sessionsResult([row(mainKey, { hasActiveRun: true, status: "done" })], 1);
  expect(
    reconcileSessionRunTerminal(result, {
      sessionKeys: ["main"],
      runId: "run-1",
      status: "done",
      endedAt: 160,
    }),
  ).toBe(result);
});

it("refreshes stale active rows after a terminal session message", async () => {
  vi.useFakeTimers();
  const list = vi
    .fn()
    .mockResolvedValueOnce(
      sessionsResult([row(mainKey, { hasActiveRun: true, status: "running" })], 1),
    )
    .mockResolvedValueOnce(
      sessionsResult([row(mainKey, { updatedAt: 2, hasActiveRun: false, status: "done" })], 2),
    );
  const { sessions, emitEvent, request } = sessionHarness({ "sessions.list": list });
  await sessions.refresh({ agentId: "main", force: true });
  emitEvent({
    type: "event",
    event: "session.message",
    payload: {
      sessionKey: mainKey,
      updatedAt: 1,
      status: "done",
    },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sessions.state.result?.sessions[0]).toMatchObject({
    key: mainKey,
    hasActiveRun: false,
    status: "done",
  });
  expect(request).toHaveBeenCalledTimes(2);
  sessions.dispose();
});
