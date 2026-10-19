// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import {
  sessionRpcHarness as permissionHarness,
  liveSessionEvent,
  patchReceipt,
} from "./session-rpc.test-support.ts";

function permissionRow(
  key: string,
  sessionId: string,
  updatedAt: number,
  permissionMode: GatewaySessionRow["permissionMode"],
) {
  return { key, sessionId, updatedAt, permissionMode, kind: "direct" as const };
}

it.each(["  generation-b  ", "  "])(
  "binds the normalized expected incarnation %j instead of a stale primary row",
  async (expectedSessionId) => {
    const key = "agent:main:permission-successor";
    const original = permissionRow(key, "generation-a", 1, "guarded");
    const successor = { ...original, sessionId: "generation-b", updatedAt: 3 };
    let listCalls = 0;
    const { sessions } = permissionHarness({
      "sessions.patch": () =>
        patchReceipt(key, {
          sessionId: successor.sessionId,
          updatedAt: 4,
          permissionMode: "full",
        }),
      "sessions.list": () => {
        listCalls += 1;
        return sessionsResult(
          [
            listCalls === 1
              ? original
              : listCalls === 2
                ? successor
                : { ...successor, updatedAt: 4, permissionMode: "full" },
          ],
          listCalls,
        );
      },
    });
    await sessions.refresh({ force: true });
    await sessions.refreshList({ agentId: "main", includeDerivedTitles: false });
    expect(sessions.state.result?.sessions[0]?.sessionId).toBe(original.sessionId);
    await sessions.patch(key, { permissionMode: "full" }, { expectedSessionId });

    expect(sessions.state.result?.sessions[0]).toMatchObject({
      sessionId: successor.sessionId,
      permissionMode: "full",
    });
    expect(listCalls).toBe(3);
    expect(sessions.state.loading).toBe(false);
  },
);

it.each([
  { eventAt: 2, ackAt: 3, eventMode: "guarded", expected: "workspace", expectedLists: 2 },
  { eventAt: 2, ackAt: 3, eventMode: "full", expected: "workspace", expectedLists: 2 },
  { eventAt: 3, ackAt: 2, eventMode: "guarded", expected: "guarded", expectedLists: 1 },
] as const)(
  "keeps the newer permission when a $eventMode snapshot at $eventAt crosses an acknowledgment at $ackAt",
  async ({ eventAt, ackAt, eventMode, expected, expectedLists }) => {
    const key = "agent:main:permission-pending";
    const sessionId = "permission-pending-generation";
    const patch = createDeferred<SessionsPatchResult>();
    let listCalls = 0;
    const { sessions, emitEvent } = permissionHarness({
      "sessions.patch": () => patch.promise,
      "sessions.list": () => {
        listCalls += 1;
        if (ackAt < eventAt && listCalls > 1) {
          throw new Error("Roster unavailable");
        }
        return sessionsResult(
          [
            permissionRow(
              key,
              sessionId,
              listCalls === 1 ? 1 : 3,
              listCalls === 1 ? "guarded" : "workspace",
            ),
          ],
          listCalls,
        );
      },
    });
    await sessions.refresh({ force: true });
    const pending = sessions.patch(key, { permissionMode: "workspace" });
    emitEvent(liveSessionEvent(permissionRow(key, sessionId, eventAt, eventMode), {}));
    patch.resolve(patchReceipt(key, { sessionId, updatedAt: ackAt, permissionMode: "workspace" }));
    await pending;
    expect(sessions.state.result?.sessions[0]?.permissionMode).toBe(expected);
    expect(sessions.state.loading).toBe(false);
    expect(listCalls).toBe(expectedLists);
  },
);

it.each([
  ["none", "workspace", 2, "workspace"],
  ["after", "workspace", 2, "workspace"],
  ["before", "guarded", 1, "workspace"],
  ["before", "full", 1, "full"],
  ["other-incarnation", "full", 1, "workspace"],
] as const)(
  "keeps permission and refresh error with descriptor %s/%s, ack at %s",
  async (read, mode, ackAt, expected) => {
    const key = "agent:main:permission-refresh";
    const sessionId = "permission-refresh-generation";
    const initial = { ...permissionRow(key, sessionId, 1, "guarded"), label: "Permission refresh" };
    const confirmed = { ...initial, permissionMode: "workspace" as const, updatedAt: ackAt };
    const readBeforeAck = read === "before" || read === "other-incarnation";
    const described = {
      ...initial,
      permissionMode: mode,
      sessionId: read === "other-incarnation" ? "other-generation" : sessionId,
      updatedAt: readBeforeAck ? initial.updatedAt : ackAt,
    };
    const acknowledgement = createDeferred<SessionsPatchResult>();
    const patchRequested = createDeferred();
    const refresh = createDeferred<SessionsListResult>();
    const refreshRequested = createDeferred();
    const patchResult = patchReceipt(key, confirmed);
    let listCalls = 0;
    const { gateway, sessions } = permissionHarness({
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": () => {
        listCalls += 1;
        if (listCalls === 1) {
          return sessionsResult([initial], 1);
        }
        refreshRequested.resolve();
        return refresh.promise;
      },
      "sessions.patch": () => {
        patchRequested.resolve();
        return acknowledgement.promise;
      },
      "sessions.describe": () => ({ session: { ...described } }),
    });
    const observation = sessions.observeRow({ key, agentId: "main" }, () => undefined);
    const readDescriptor = async () => {
      const reconcile = observation.captureReconcile();
      const result = await gateway.snapshot.client!.request<{ session: typeof described }>(
        "sessions.describe",
        { key },
      );
      expect(reconcile(result.session)).toMatchObject({
        status: "current",
        row: read === "other-incarnation" ? initial : described,
      });
    };
    let pending: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ force: true });
      pending = sessions.patch(key, { permissionMode: "workspace" });
      await patchRequested.promise;
      if (readBeforeAck) {
        await readDescriptor();
      }
      acknowledgement.resolve(patchResult);
      await refreshRequested.promise;
      if (read === "after") {
        await readDescriptor();
      }
      refresh.reject(new Error("Roster refresh unavailable"));

      const result = await pending;
      expect(result).toMatchObject({ listRefreshError: "Roster refresh unavailable" });
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ ...confirmed, permissionMode: expected }),
      ]);
      expect(observation.row).toMatchObject({ sessionId, permissionMode: expected });
      expect(sessions.state.error).toContain("Roster refresh unavailable");
    } finally {
      acknowledgement.resolve(patchResult);
      refresh.resolve(sessionsResult([confirmed], ackAt));
      await pending;
      sessions.dispose();
    }
  },
);

it("discards patch A and its refresh after patch B applies first", async () => {
  const key = "agent:main:permission-ordering";
  const sessionId = "permission-ordering-generation";
  const patchA = createDeferred<SessionsPatchResult>();
  const patchB = createDeferred<SessionsPatchResult>();
  let listCalls = 0;
  const { sessions, request } = permissionHarness({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.list": () => {
      listCalls += 1;
      if (listCalls > 2) {
        throw new Error("Obsolete refresh should not run");
      }
      return sessionsResult(
        [permissionRow(key, sessionId, listCalls, listCalls === 1 ? "guarded" : "full")],
        1,
      );
    },
    "sessions.patch": (params) => {
      const permissionMode = (params as { permissionMode?: unknown })?.permissionMode;
      return permissionMode === "workspace" ? patchA.promise : patchB.promise;
    },
  });
  await sessions.refresh({ force: true });

  const older = sessions.patch(key, { permissionMode: "workspace" });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ permissionMode: "workspace" }),
    ),
  );
  const newer = sessions.patch(key, { permissionMode: "full" });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ permissionMode: "full" }),
    ),
  );
  patchB.resolve(
    patchReceipt(
      key,
      { permissionMode: "full", sessionId, updatedAt: 2 },
      "/sessions/permission-ordering.jsonl",
    ),
  );
  await newer;
  patchA.resolve(
    patchReceipt(
      key,
      { permissionMode: "workspace", sessionId, updatedAt: 3 },
      "/sessions/permission-ordering.jsonl",
    ),
  );
  await older;

  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key, permissionMode: "full", sessionId, updatedAt: 2 }),
  ]);
  expect(listCalls).toBe(2);
});

it.each(["success", "failure"])(
  "settles patch A refresh %s after event B applies",
  async (outcome) => {
    const key = "agent:main:permission-refresh-ordering";
    const sessionId = "permission-refresh-ordering-generation";
    const refreshA = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const { sessions, emitEvent } = permissionHarness({
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": () => {
        listCalls += 1;
        return listCalls === 1
          ? sessionsResult([permissionRow(key, sessionId, 1, "guarded")], 1)
          : refreshA.promise;
      },
      "sessions.patch": () =>
        patchReceipt(
          key,
          { permissionMode: "workspace", sessionId, updatedAt: 2 },
          "/sessions/permission-refresh-ordering.jsonl",
        ),
    });
    await sessions.refresh({ force: true });

    const older = sessions.patch(key, { permissionMode: "workspace" });
    await vi.waitFor(() => expect(listCalls).toBe(2));
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: key,
        key,
        kind: "direct",
        reason: "patch",
        permissionMode: "full",
        sessionId,
        updatedAt: 3,
      },
    });
    if (outcome === "failure") {
      refreshA.reject(new Error("obsolete refresh failed"));
    } else {
      refreshA.resolve(sessionsResult([permissionRow(key, sessionId, 2, "workspace")], 2));
    }

    await expect(older).resolves.not.toHaveProperty("listRefreshError");
    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key,
        permissionMode: "full",
        sessionId,
        updatedAt: 3,
      }),
    ]);
    expect(sessions.state.error).toBeNull();
    expect(sessions.state.loading).toBe(false);
  },
);
