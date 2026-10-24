// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import {
  sessionRow as row,
  patchReply as ack,
  sessionRpcHarness,
  liveSessionEvent,
} from "./session-rpc.test-support.ts";
const selectionHarness = (handlers: Parameters<typeof sessionRpcHarness>[0]) =>
  sessionRpcHarness(handlers, createTestGatewayClient);
function targetOptions(target: GatewaySessionRow) {
  return { agentId: "main", expectedSessionId: target.sessionId };
}

it.each(
  (["rename", "archive", "delete", "category"] as const).flatMap((operation) =>
    (["loaded", "queued", "global"] as const).map((foreground) => ({ operation, foreground })),
  ),
)(
  "$operation preserves $foreground selection and reconciles managed lists",
  async ({ operation, foreground }) => {
    vi.useFakeTimers();
    const original = row("original", { label: "Original" });
    const changes = {
      rename: { label: "Renamed" },
      archive: { archived: true },
      category: { category: "Moved" },
      delete: {},
    }[operation];
    const base = { ...original, archived: false, category: undefined };
    const writer = { key: "agent:writer:first", sessionId: "writer", kind: "direct" as const };
    const reply = createDeferred<unknown>();
    const blocked = createDeferred<SessionsListResult>();
    let holdMain = false;
    let committed = false;
    const { sessions, request } = selectionHarness({
      "sessions.patch": () => reply.promise,
      "sessions.delete": () => reply.promise,
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": (raw) => {
        const params = (raw ?? {}) as Record<string, unknown>;
        if (holdMain && params.agentId === "main" && !params.search) {
          holdMain = false;
          return blocked.promise;
        }
        const mainRows =
          committed && operation === "delete" ? [] : [{ ...base, ...(committed ? changes : {}) }];
        return sessionsResult(params.agentId === "writer" ? [writer] : mainRows, committed ? 2 : 1);
      },
    });
    const managed = { agentId: "main", search: "original" };
    sessions.subscribeList(managed, () => {});
    let mutation: Promise<unknown> | undefined;
    let pendingRead: Promise<void> | undefined;
    let selecting: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList(managed);
      const options = targetOptions(original);
      mutation =
        operation === "delete"
          ? sessions.delete(original.key, options)
          : sessions.patch(original.key, { ...changes }, options);
      if (foreground === "queued") {
        holdMain = true;
        pendingRead = sessions.refresh({ agentId: "main", force: true });
      }
      selecting = sessions.refresh({
        agentId: foreground === "global" ? undefined : "writer",
        force: true,
      });
      if (foreground !== "queued") {
        await selecting;
      }
      committed = true;
      reply.resolve(
        operation === "delete"
          ? { ok: true, deleted: true, key: original.key }
          : ack(original, {
              label: "Renamed",
              archived: operation === "archive",
              category: operation === "category" ? "Moved" : undefined,
            }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      if (foreground === "queued") {
        // The mutation has reached reconciliation while the old primary request
        // still holds the foreground selection in the roster queue.
        expect(sessions.listSnapshot(managed).result?.ts).toBe(2);
      }
      blocked.resolve(sessionsResult([original], 1));
      await pendingRead;
      await selecting;
      await mutation;
      expect(sessions.state.agentId).toBe(foreground === "global" ? null : "writer");
      if (foreground !== "global") {
        expect(sessions.state.result?.sessions.map(({ key }) => key)).toEqual([writer.key]);
      }
      expect(sessions.listSnapshot(managed).result?.ts).toBe(2);
      const affected = sessions.listSnapshot(managed).result?.sessions ?? [];
      if (operation === "delete") {
        expect(affected).toEqual([]);
      } else {
        expect(affected[0]).toMatchObject(changes);
      }
      expect(
        request.mock.calls.find(
          ([method]) => method === (operation === "delete" ? "sessions.delete" : "sessions.patch"),
        )?.[1],
      ).toMatchObject({ key: original.key, ...options });
      expect(sessions.state.loading).toBe(false);
    } finally {
      reply.resolve({ ok: true, key: original.key });
      blocked.resolve(sessionsResult([original], 1));
      await Promise.allSettled([mutation, pendingRead, selecting]);
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);

it("does not attribute another agent's roster error to a completed previous-connection mutation", async () => {
  const reply = createDeferred<unknown>();
  const original = row("previous");
  const { sessions, publish } = selectionHarness({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.patch": () => reply.promise,
    "sessions.list": (raw) => {
      if ((raw as { agentId?: string })?.agentId === "writer") {
        throw new Error("Writer roster unavailable");
      }
      return sessionsResult([original], 1);
    },
  });
  let mutation: Promise<unknown> | undefined;
  try {
    await sessions.refresh({ agentId: "main", force: true });
    mutation = sessions.patch(original.key, { label: "Renamed" }, targetOptions(original));
    publish(false);
    publish(true);
    await sessions.refresh({ agentId: "writer", force: true });
    expect(sessions.state.error).toBe("Writer roster unavailable");
    reply.resolve(ack(original, { label: "Renamed" }));
    await expect(mutation).resolves.toMatchObject({ ok: true, key: original.key });
    expect(sessions.state.error).toContain("previous connection");
    expect(sessions.state.error).not.toContain("Writer roster unavailable");
    expect(sessions.state.error).not.toContain("refresh failed");
  } finally {
    reply.resolve({ ok: true, key: original.key });
    await mutation;
    sessions.dispose();
  }
});

it.each(["success", "failure", "retired"] as const)(
  "reconciles an equal-clock permission conflict without replacing another agent's roster (%s)",
  async (outcome) => {
    const reply = createDeferred<unknown>();
    const canonical = createDeferred<SessionsListResult>();
    let canonicalRequested = false;
    const original = row("permission-tie", { updatedAt: 1, permissionMode: "guarded" });
    const writer = { key: "agent:writer:main", sessionId: "writer-main", kind: "direct" as const };
    let acknowledged = false;
    const { sessions, emitEvent, publish } = selectionHarness({
      "sessions.patch": () => reply.promise,
      "sessions.list": (raw) => {
        if (acknowledged && (raw as { agentId?: string })?.agentId !== "writer") {
          canonicalRequested = true;
          return canonical.promise;
        }
        return sessionsResult(
          (raw as { agentId?: string })?.agentId === "writer"
            ? [writer]
            : [
                {
                  ...original,
                  updatedAt: acknowledged ? 2 : 1,
                  permissionMode: acknowledged ? "workspace" : "guarded",
                },
              ],
          acknowledged ? 2 : 1,
        );
      },
    });
    let mutation: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const observed = sessions.observeRow({ key: original.key, agentId: "main" }, () => {});
      mutation = sessions.patch(
        original.key,
        { permissionMode: "workspace" },
        targetOptions(original),
      );
      emitEvent(liveSessionEvent(original, { updatedAt: 2, permissionMode: "full" }));
      await sessions.refresh({ agentId: "writer", force: true });
      expect(observed.row?.permissionMode).toBe("full");
      acknowledged = true;
      reply.resolve(ack(original, { updatedAt: 2, permissionMode: "workspace" }));
      await vi.waitFor(() => expect(canonicalRequested).toBe(true));
      if (outcome === "failure") {
        canonical.reject(new Error("Original agent read unavailable"));
        await expect(mutation).resolves.toMatchObject({
          listRefreshError: "Original agent read unavailable",
        });
        expect(observed.row?.permissionMode).toBe("full");
      } else {
        if (outcome === "retired") {
          publish(false);
        }
        canonical.resolve(
          sessionsResult([{ ...original, updatedAt: 2, permissionMode: "workspace" }], 2),
        );
        if (outcome === "retired") {
          await expect(mutation).resolves.toBeNull();
          expect(observed.row).toBeNull();
          return;
        }
        await mutation;
        expect(observed.row?.permissionMode).toBe("workspace");
      }
      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual([writer]);
      expect(sessions.state.error).toBeNull();
    } finally {
      reply.resolve(ack(original));
      canonical.resolve(sessionsResult([original], 1));
      await mutation;
      sessions.dispose();
    }
  },
);

it.each(["global", "queued-global", "queued-append", "queued-append-rename"] as const)(
  "reconciles a target omitted from the selected page (%s)",
  async (selection) => {
    const queued = selection !== "global";
    const append = selection.startsWith("queued-append");
    const rename = selection === "queued-append-rename";
    const reply = createDeferred<unknown>();
    const blocker = createDeferred<SessionsListResult>();
    const target = row("global-tie", {
      label: "Original target",
      updatedAt: 1,
      permissionMode: "guarded",
    });
    const changes = rename ? { label: "Renamed target" } : { permissionMode: "workspace" as const };
    const confirmed = { ...target, ...changes, updatedAt: 2 };
    const other = {
      key: append ? "agent:main:other" : "agent:writer:other",
      kind: "direct" as const,
      sessionId: "other",
    };
    let acknowledged = false;
    let hold = false;
    const { sessions, emitEvent } = selectionHarness({
      "sessions.patch": () => reply.promise,
      "sessions.list": (raw) => {
        if (!(raw as { agentId?: string })?.agentId || (raw as { offset?: number }).offset) {
          return { ...sessionsResult([other], 2), hasMore: true, nextOffset: 1 };
        }
        if (hold) {
          hold = false;
          return blocker.promise;
        }
        return sessionsResult([{ ...(acknowledged ? confirmed : target) }], 2);
      },
    });
    let mutation: ReturnType<typeof sessions.patch> | undefined;
    let reading: Promise<void> | undefined;
    let selecting: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const observed = sessions.observeRow({ key: target.key, agentId: "main" }, () => {});
      mutation = sessions.patch(target.key, { ...changes }, targetOptions(target));
      if (queued) {
        hold = true;
        reading = sessions.refresh({ agentId: "main", force: true });
      }
      if (!rename) {
        emitEvent(liveSessionEvent(target, { updatedAt: 2, permissionMode: "full" }));
      }
      selecting = sessions.refresh(
        append ? { agentId: "main", append: true, offset: 1, force: true } : { force: true },
      );
      if (!queued) {
        await selecting;
      }
      acknowledged = true;
      reply.resolve(ack(confirmed));
      blocker.resolve(
        sessionsResult([rename ? target : { ...target, updatedAt: 2, permissionMode: "full" }], 2),
      );
      await reading;
      await selecting;
      await mutation;
      const field = rename ? "label" : "permissionMode";
      const expected = rename ? "Renamed target" : "workspace";
      expect(observed.row?.[field]).toBe(expected);
      expect(sessions.state.agentId).toBe(append ? "main" : null);
      if (append) {
        expect(
          sessions.state.result?.sessions.find((entry) => entry.key === target.key)?.[field],
        ).toBe(expected);
      }
      expect(sessions.state.result).toMatchObject({
        sessions: append ? [expect.objectContaining({ key: target.key }), other] : [other],
        hasMore: true,
        nextOffset: 1,
      });
      expect(sessions.state.error).toBeNull();
    } finally {
      reply.resolve(ack(target));
      blocker.resolve(sessionsResult([target], 1));
      await Promise.allSettled([mutation, reading, selecting]);
      sessions.dispose();
    }
  },
);
