// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionListSnapshot } from "./session-capability.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

function rowPinned(result: SessionsListResult | null, key: string): boolean {
  return result?.sessions.find((row) => row.key === key)?.pinned === true;
}

// Shape of `buildGatewaySessionEventFields`: every payload carries the server's
// current pin state, which is the pre-click value while a patch is in flight.
function sessionChangedPayload(key: string, pinned: boolean) {
  return {
    sessionKey: key,
    sessionId: `${key}:session`,
    reason: "send",
    key,
    kind: "direct",
    updatedAt: 3,
    pinned,
    pinnedAt: pinned ? 2 : null,
  };
}

function pinHarness(options: {
  patchResponse: (call: number) => Promise<unknown>;
  serverPinned: () => boolean;
}) {
  const key = "agent:main:alpha";
  let patchCalls = 0;
  let listTs = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      patchCalls += 1;
      return await options.patchResponse(patchCalls);
    }
    if (method === "sessions.list") {
      listTs += 1;
      return sessionsResult(
        [
          {
            key,
            sessionId: `${key}:session`,
            kind: "direct",
            updatedAt: 1,
            pinned: options.serverPinned(),
          },
        ],
        listTs,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...harness, key };
}

describe("session pin mutations", () => {
  it("preserves fresh row facts when deletion rolls back during a pin and read mutation", async () => {
    vi.useFakeTimers();
    const key = "agent:main:rollback-provenance";
    const initial: GatewaySessionRow = {
      key,
      agentId: "main",
      sessionId: "rollback-provenance-session",
      kind: "direct",
      archived: false,
      updatedAt: 10,
      pinned: false,
      unread: true,
      lastReadAt: 0,
      lastActivityAt: 10,
      lastMessagePreview: "Before streaming output",
    };
    const fresh = { ...initial, lastMessagePreview: "New streaming output" };
    let current = initial;
    const patchReply = createDeferred<unknown>();
    const deleteReply = createDeferred<unknown>();
    const describeReply = createDeferred<{ session: GatewaySessionRow }>();
    const patchDispatched = createDeferred();
    const deleteDispatched = createDeferred();
    const unexpectedMethods: string[] = [];
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([current], 10);
      }
      if (method === "sessions.patch") {
        patchDispatched.resolve();
        return patchReply.promise;
      }
      if (method === "sessions.delete") {
        deleteDispatched.resolve();
        return deleteReply.promise;
      }
      if (method === "sessions.describe") {
        return describeReply.promise;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      unexpectedMethods.push(method);
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    const pending: Promise<unknown>[] = [];
    try {
      await sessions.refresh({ agentId: "main", force: true, includeLastMessage: true });
      const patching = sessions.patch(
        key,
        { pinned: true, unread: false },
        {
          agentId: "main",
          expectedSessionId: initial.sessionId,
          deferListRefresh: true,
        },
      );
      pending.push(patching);
      await patchDispatched.promise;
      const reconcile = sessions.captureReconcile();
      const reading = client.request<{ session: GatewaySessionRow }>("sessions.describe", {
        key,
        includeLastMessage: true,
      });
      pending.push(reading);
      const deleting = sessions
        .delete(key, {
          agentId: "main",
          expectedSessionId: initial.sessionId,
        })
        .catch((error: unknown) => error);
      pending.push(deleting);
      await deleteDispatched.promise;
      expect(sessions.state.result?.sessions).toEqual([]);

      current = fresh;
      await sessions.refresh({ agentId: "main", force: true, includeLastMessage: true });
      expect(sessions.state.result?.sessions).toEqual([]);
      deleteReply.reject(new Error("Deletion temporarily unavailable"));
      expect(await deleting).toMatchObject({ message: "Deletion temporarily unavailable" });
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ ...fresh, pinned: true, unread: false }),
      ]);

      describeReply.resolve({ session: initial });
      reconcile((await reading).session);
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ ...fresh, pinned: true, unread: false }),
      ]);
      patchReply.resolve({
        ok: true,
        path: "(multiple)",
        key,
        entry: {
          sessionId: initial.sessionId,
          updatedAt: 20,
          pinnedAt: 20,
          lastReadAt: 20,
          lastActivityAt: 10,
        },
      });
      await expect(patching).resolves.toBeTruthy();
      expect(sessions.state.result?.sessions[0]?.lastMessagePreview).toBe(fresh.lastMessagePreview);
      expect(unexpectedMethods).toEqual([]);
    } finally {
      try {
        sessions.dispose();
        describeReply.resolve({ session: initial });
        deleteReply.resolve({ deleted: false });
        patchReply.resolve({
          ok: true,
          path: "(multiple)",
          key,
          entry: { sessionId: initial.sessionId },
        });
        await Promise.allSettled(pending);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("keeps newer pin and read events ahead of an older successful acknowledgment", async () => {
    vi.useFakeTimers();
    const key = "agent:main:newer-event-fields";
    const sessionId = "newer-event-fields";
    const initial: GatewaySessionRow = {
      key,
      agentId: "main",
      sessionId,
      kind: "direct",
      updatedAt: 10,
      archived: false,
      pinned: false,
      unread: true,
      lastReadAt: 0,
      lastActivityAt: 10,
    };
    let current = initial;
    const acknowledgment = {
      ok: true,
      path: "(multiple)",
      key,
      entry: {
        sessionId,
        updatedAt: 20,
        pinnedAt: 20,
        lastReadAt: 20,
        lastActivityAt: 10,
      },
    };
    const response = createDeferred<typeof acknowledgment>();
    const dispatched = createDeferred();
    const unexpectedMethods: string[] = [];
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([current], current.updatedAt ?? 0);
      }
      if (method === "sessions.patch") {
        dispatched.resolve();
        return response.promise;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      unexpectedMethods.push(method);
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    let operation: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ force: true, agentId: "main" });
      operation = sessions.patch(
        key,
        { pinned: true, unread: false },
        { agentId: "main", expectedSessionId: sessionId, deferListRefresh: true },
      );
      await dispatched.promise;
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: key,
          key,
          agentId: "main",
          sessionId,
          reason: "patch",
          kind: "direct",
          ts: 30,
          updatedAt: 30,
          archived: false,
          pinned: false,
          pinnedAt: null,
          unread: true,
          lastReadAt: 20,
          lastActivityAt: 30,
          markedUnreadAt: null,
        },
      });
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ key, sessionId, pinned: true, unread: false }),
      ]);

      response.resolve(acknowledgment);
      await expect(operation).resolves.toBeTruthy();
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ key, sessionId, pinned: false, unread: true }),
      ]);

      current = {
        ...initial,
        updatedAt: 40,
        pinned: true,
        pinnedAt: 40,
        unread: false,
        lastReadAt: 40,
        lastActivityAt: 30,
      };
      await sessions.refresh({ force: true, agentId: "main" });
      expect(sessions.state.result?.sessions).toEqual([
        expect.objectContaining({ key, sessionId, pinned: true, pinnedAt: 40, unread: false }),
      ]);
      expect(unexpectedMethods).toEqual([]);
    } finally {
      try {
        sessions.dispose();
        response.resolve(acknowledgment);
        await Promise.allSettled(operation ? [operation] : []);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("keeps acknowledged pin and read fields when an earlier describe finishes", async () => {
    const key = "agent:main:acknowledged-fields";
    const initial: GatewaySessionRow = {
      key,
      sessionId: "acknowledged-fields",
      kind: "direct",
      updatedAt: 10,
      pinned: false,
      unread: true,
      lastReadAt: 0,
      lastActivityAt: 10,
    };
    let current = initial;
    const delayed = createDeferred<{ session: GatewaySessionRow }>();
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([current], current.updatedAt ?? 0);
      }
      if (method === "sessions.describe") {
        return delayed.promise;
      }
      if (method === "sessions.patch") {
        current = {
          ...initial,
          updatedAt: 20,
          pinned: true,
          pinnedAt: 20,
          unread: false,
          lastReadAt: 20,
        };
        return {
          ok: true,
          path: "(multiple)",
          key,
          entry: {
            sessionId: initial.sessionId,
            updatedAt: 20,
            pinnedAt: 20,
            lastReadAt: 20,
            lastActivityAt: 10,
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    let reading: Promise<{ session: GatewaySessionRow }> | undefined;
    try {
      await sessions.refresh({ force: true, agentId: "main" });
      const reconcile = sessions.captureReconcile();
      reading = client.request<{ session: GatewaySessionRow }>("sessions.describe", { key });
      await sessions.patch(
        key,
        { pinned: true, unread: false },
        {
          agentId: "main",
          expectedSessionId: initial.sessionId,
          deferListRefresh: true,
        },
      );
      const confirmed = { pinned: true, pinnedAt: 20, unread: false, lastReadAt: 20 };
      expect(sessions.state.result?.sessions[0]).toMatchObject(confirmed);
      delayed.resolve({ session: initial });
      reconcile((await reading).session);
      expect(sessions.state.result?.sessions[0]).toMatchObject(confirmed);
    } finally {
      sessions.dispose();
      delayed.resolve({ session: initial });
      await reading;
    }
  });

  it("keeps a pending pin through a stale Gateway event and its canonical refresh", async () => {
    vi.useFakeTimers();
    try {
      const committed = createDeferred<unknown>();
      let serverPinned = false;
      const { gateway, key, emitEvent } = pinHarness({
        patchResponse: () => committed.promise,
        serverPinned: () => serverPinned,
      });
      const sessions = createTestSessionCapability(gateway);

      await sessions.refresh({ force: true });
      const operation = sessions.patch(key, { pinned: true });
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      // A routine turn event for the same row, still carrying the pre-patch pin
      // value, reaches both the direct merge and the canonical list refresh.
      const stalePayload = sessionChangedPayload(key, false);
      sessions.reconcileChanged(stalePayload);
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      emitEvent({ type: "event", event: "sessions.changed", payload: stalePayload });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      serverPinned = true;
      committed.resolve({
        ok: true,
        key,
        path: "",
        entry: { sessionId: `${key}:session`, updatedAt: 4, pinnedAt: 4 },
      });
      await expect(operation).resolves.toBeTruthy();
      expect(rowPinned(sessions.state.result, key)).toBe(true);
      sessions.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls a rejected unpin back across the primary and filtered lists", async () => {
    const { gateway, key } = pinHarness({
      patchResponse: () => Promise.reject(new Error("pin rejected")),
      serverPinned: () => true,
    });
    const sessions = createTestSessionCapability(gateway);
    // The archived/all sidebar reads its own snapshot, so the intent has to
    // reach that list and leave it on the same value the primary state shows.
    const filtered: SessionListSnapshot[] = [];
    const stopFiltered = sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
      filtered.push(snapshot);
    });
    const filteredRowPinned = () => rowPinned(filtered.at(-1)?.result ?? null, key);

    await sessions.refresh({ force: true });
    await sessions.refreshList({ archivedFilter: "all", force: true });
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(filteredRowPinned()).toBe(true);

    const operation = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);
    expect(filteredRowPinned()).toBe(false);

    await expect(operation).rejects.toThrow("pin rejected");
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(filteredRowPinned()).toBe(true);
    expect(sessions.state.error).toContain("pin rejected");
    stopFiltered();
    sessions.dispose();
  });

  it("rolls a filtered-only row back to the pin the Gateway kept", async () => {
    const key = "agent:other:beta";
    const request = vi.fn(async (method: string, params?: { archived?: unknown }) => {
      if (method === "sessions.patch") {
        throw new Error("unpin rejected");
      }
      if (method === "sessions.list") {
        // Only the all-filtered sidebar publishes this row, so the rollback
        // baseline cannot come from the primary snapshot.
        return params?.archived === "all"
          ? sessionsResult(
              [
                {
                  key,
                  sessionId: `${key}:session`,
                  kind: "direct",
                  updatedAt: 1,
                  pinned: true,
                  pinnedAt: 7,
                },
              ],
              1,
            )
          : sessionsResult([], 1);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const filtered: SessionListSnapshot[] = [];
    const stopFiltered = sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
      filtered.push(snapshot);
    });
    const filteredRow = () => filtered.at(-1)?.result?.sessions.find((row) => row.key === key);

    await sessions.refresh({ force: true });
    await sessions.refreshList({ archivedFilter: "all", force: true });
    expect(sessions.state.result?.sessions).toHaveLength(0);
    expect(filteredRow()?.pinned).toBe(true);

    const operation = sessions.patch(key, { pinned: false });
    expect(filteredRow()?.pinned).toBe(false);

    await expect(operation).rejects.toThrow("unpin rejected");
    expect(filteredRow()?.pinned).toBe(true);
    expect(filteredRow()?.pinnedAt).toBe(7);
    stopFiltered();
    sessions.dispose();
  });

  it("rolls a failed unpin back to the pin an overlapping completion confirmed", async () => {
    const pinCommitted = createDeferred<unknown>();
    const unpinRejected = createDeferred<unknown>();
    let serverPinned = false;
    const { gateway, key } = pinHarness({
      patchResponse: (call) => (call === 1 ? pinCommitted.promise : unpinRejected.promise),
      serverPinned: () => serverPinned,
    });
    const sessions = createTestSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const pin = sessions.patch(key, { pinned: true });
    const unpin = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    serverPinned = true;
    pinCommitted.resolve({
      ok: true,
      key,
      path: "",
      entry: { sessionId: `${key}:session`, updatedAt: 4, pinnedAt: 4 },
    });
    await expect(pin).resolves.toBeTruthy();
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    unpinRejected.reject(new Error("unpin rejected"));
    await expect(unpin).rejects.toThrow("unpin rejected");
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(sessions.state.error).toContain("unpin rejected");
    sessions.dispose();
  });
});
