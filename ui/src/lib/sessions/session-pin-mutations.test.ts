// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionRequest as sessionRpc } from "./hydration-family.test-support.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import { ownRoster } from "./session-roster-refresh.test-support.ts";
import { patchReceipt, sessionChanged } from "./session-rpc.test-support.ts";

function bareRow(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, sessionId: `${key}:session`, kind: "direct", updatedAt: 10, ...fields };
}
function pinRow(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    ...bareRow(key),
    pinned: false,
    unread: true,
    lastReadAt: 0,
    lastActivityAt: 10,
    ...fields,
  };
}
const ack = (key: string, entry: Partial<GatewaySessionRow>, path = "(multiple)") =>
  patchReceipt(key, entry, path);
function pinFields(sessionId: string | undefined) {
  return { sessionId, updatedAt: 20, pinnedAt: 20, lastReadAt: 20, lastActivityAt: 10 };
}
const primary = { agentId: "main", force: true };
const archived = { ...primary, archivedFilter: "all" as const };
const enriched = { ...primary, includeLastMessage: true };

function fixture(client: GatewayBrowserClient, fakeTimers = false) {
  if (fakeTimers) {
    vi.useFakeTimers();
  }
  const gateway = createGatewayHarness(client);
  const owner = ownRoster(gateway.gateway);
  const { sessions } = owner;
  return {
    ...gateway,
    ...owner,
    client,
    track<T>(operation: Promise<T>) {
      owner.settle(() => Promise.allSettled([operation]));
      return operation;
    },
    patchPin: (row: GatewaySessionRow) =>
      sessions.patch(
        row.key,
        { pinned: true, unread: false },
        { agentId: "main", expectedSessionId: row.sessionId, deferListRefresh: true },
      ),
  };
}

function rowFixture(
  initial: GatewaySessionRow,
  handlers: Record<string, () => unknown>,
  fakeTimers = false,
) {
  const source = { current: initial };
  const client = createTestGatewayClient(
    sessionRpc({
      ...handlers,
      "sessions.list": () => sessionsResult([source.current], source.current.updatedAt ?? 0),
    }),
  );
  return { ...fixture(client, fakeTimers), source };
}

function pinFixture(patchResponse: (call: number) => Promise<unknown>, fakeTimers = false) {
  const key = "agent:main:alpha";
  const server = { pinned: false };
  let patchCalls = 0;
  let listTs = 0;
  const request = sessionRpc({
    "sessions.patch": () => patchResponse(++patchCalls),
    "sessions.list": () =>
      sessionsResult([bareRow(key, { updatedAt: 1, pinned: server.pinned })], ++listTs),
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  const harness = fixture({ request } as unknown as GatewayBrowserClient, fakeTimers);
  return {
    ...harness,
    key,
    server,
    pinned: () => harness.rows()?.find((row) => row.key === key)?.pinned === true,
    commit: (reply: ReturnType<typeof createDeferred<unknown>>) =>
      reply.resolve(ack(key, { sessionId: `${key}:session`, updatedAt: 4, pinnedAt: 4 }, "")),
  };
}

describe("session pin mutations", () => {
  it("preserves fresh row facts when deletion rolls back during a pin and read mutation", async () => {
    const key = "agent:main:rollback-provenance";
    const initial = pinRow(key, {
      agentId: "main",
      sessionId: "rollback-provenance-session",
      archived: false,
      lastMessagePreview: "Before streaming output",
    });
    const fresh = { ...initial, lastMessagePreview: "New streaming output" };
    const patchReply = createDeferred<unknown>();
    const deleteReply = createDeferred<unknown>();
    const describeReply = createDeferred<{ session: GatewaySessionRow }>();
    const patchDispatched = createDeferred();
    const deleteDispatched = createDeferred();
    const h = rowFixture(
      initial,
      {
        "sessions.patch": () => {
          patchDispatched.resolve();
          return patchReply.promise;
        },
        "sessions.delete": () => {
          deleteDispatched.resolve();
          return deleteReply.promise;
        },
        "sessions.describe": () => describeReply.promise,
        "sessions.subscribe": () => ({ subscribed: true }),
      },
      true,
    );
    h.settle(() => {
      describeReply.resolve({ session: initial });
      deleteReply.resolve({ deleted: false });
      patchReply.resolve(ack(key, { sessionId: initial.sessionId }));
    });
    await h.sessions.refresh(enriched);
    const patching = h.track(h.patchPin(initial));
    await patchDispatched.promise;
    const reconcile = h.sessions.captureReconcile();
    const reading = h.track(
      h.client.request<{ session: GatewaySessionRow }>("sessions.describe", {
        key,
        includeLastMessage: true,
      }),
    );
    const deleting = h.track(
      h.sessions
        .delete(key, { agentId: "main", expectedSessionId: initial.sessionId })
        .catch((error: unknown) => error),
    );
    await deleteDispatched.promise;
    expect(h.rows()).toEqual([]);
    h.source.current = fresh;
    await h.sessions.refresh(enriched);
    expect(h.rows()).toEqual([]);
    deleteReply.reject(new Error("Deletion temporarily unavailable"));
    expect(await deleting).toMatchObject({ message: "Deletion temporarily unavailable" });
    const expected = [expect.objectContaining({ ...fresh, pinned: true, unread: false })];
    expect(h.rows()).toEqual(expected);
    describeReply.resolve({ session: initial });
    reconcile((await reading).session);
    expect(h.rows()).toEqual(expected);
    patchReply.resolve(ack(key, pinFields(initial.sessionId)));
    await expect(patching).resolves.toBeTruthy();
    expect(h.rows()?.[0]?.lastMessagePreview).toBe(fresh.lastMessagePreview);
  });

  it("keeps acknowledged pin and read fields when an earlier describe finishes", async () => {
    const key = "agent:main:acknowledged-fields";
    const initial = pinRow(key, { sessionId: "acknowledged-fields" });
    const delayed = createDeferred<{ session: GatewaySessionRow }>();
    const confirmed = { pinned: true, pinnedAt: 20, unread: false, lastReadAt: 20 };
    const h = rowFixture(initial, {
      "sessions.describe": () => delayed.promise,
      "sessions.patch": () => {
        h.source.current = { ...initial, ...confirmed, updatedAt: 20 };
        return ack(key, pinFields(initial.sessionId));
      },
    });
    h.settle(() => delayed.resolve({ session: initial }));
    await h.sessions.refresh(primary);
    const reconcile = h.sessions.captureReconcile();
    const reading = h.track(
      h.client.request<{ session: GatewaySessionRow }>("sessions.describe", { key }),
    );
    await h.patchPin(initial);
    expect(h.rows()?.[0]).toMatchObject(confirmed);
    delayed.resolve({ session: initial });
    reconcile((await reading).session);
    expect(h.rows()?.[0]).toMatchObject(confirmed);
  });

  it("keeps a pending pin through a stale Gateway event and its canonical refresh", async () => {
    const committed = createDeferred<unknown>();
    const h = pinFixture(() => committed.promise, true);
    await h.sessions.refresh({ force: true });
    const operation = h.sessions.patch(h.key, { pinned: true });
    expect(h.pinned()).toBe(true);
    h.emitEvent(
      sessionChanged({
        sessionKey: h.key,
        ...bareRow(h.key, { updatedAt: 3 }),
        reason: "send",
        pinned: false,
        pinnedAt: null,
      }),
    );
    expect(h.pinned()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pinned()).toBe(true);
    h.server.pinned = true;
    h.commit(committed);
    await expect(operation).resolves.toBeTruthy();
    expect(h.pinned()).toBe(true);
  });

  it("preserves a pending restore-and-pin through archived observations and rolls back rejection", async () => {
    const key = "agent:main:restore-pin";
    const response = createDeferred<unknown>();
    const dispatched = createDeferred();
    const h = rowFixture(
      bareRow(key, { agentId: "main", archived: true, archivedAt: 10, pinned: false }),
      {
        "sessions.patch": () => {
          dispatched.resolve();
          return response.promise;
        },
      },
    );
    const { sessionId } = h.source.current;
    h.settle(() => response.resolve(ack(key, { sessionId })));
    await h.sessions.refresh(archived);
    const observer = h.sessions.observeRow({ key, agentId: "main" }, () => {});
    h.watch(() => observer.dispose());
    const observeArchived = () =>
      h.emitEvent(
        sessionChanged({ ...h.source.current, sessionKey: key, reason: "patch", pinnedAt: null }),
      );
    const expectPin = (pinned: boolean) => {
      for (const row of [h.rows()?.[0], observer.row]) {
        expect(row).toMatchObject({ key, sessionId, archived: true, pinned });
        if (!pinned) {
          expect(row?.pinnedAt).toBeUndefined();
        }
      }
    };
    observeArchived();
    expect(h.sessions.archiveVisibility(key)).toBe("archived");
    expectPin(false);
    const operation = h.track(
      h.sessions.patch(
        key,
        { archived: false, pinned: true },
        { agentId: "main", expectedSessionId: sessionId, deferListRefresh: true },
      ),
    );
    await dispatched.promise;
    expectPin(true);
    h.source.current = { ...h.source.current, updatedAt: 20 };
    observeArchived();
    expectPin(true);
    await h.sessions.refresh(archived);
    expectPin(true);
    response.reject(new Error("Restore and pin rejected"));
    await expect(operation).rejects.toThrow("Restore and pin rejected");
    expectPin(false);
    expect(h.sessions.state.error).toContain("Restore and pin rejected");
  });

  it("rolls a filtered-only row back to the pin the Gateway kept", async () => {
    const key = "agent:other:beta";
    const request = sessionRpc({
      "sessions.patch": () => {
        throw new Error("unpin rejected");
      },
      "sessions.list": (raw) => {
        const params = raw as { archived?: unknown };
        // No primary baseline: only the all-filtered sidebar holds this row.
        return sessionsResult(
          params?.archived === "all"
            ? [bareRow(key, { updatedAt: 1, pinned: true, pinnedAt: 7 })]
            : [],
          1,
        );
      },
      "sessions.subscribe": () => ({ subscribed: true }),
    });
    const h = fixture({ request } as unknown as GatewayBrowserClient);
    let filtered: SessionsListResult | null = null;
    h.watch(
      h.sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
        filtered = snapshot.result;
      }),
    );
    const filteredRow = () => filtered?.sessions.find((row) => row.key === key);
    await h.sessions.refresh({ force: true });
    await h.sessions.refreshList({ archivedFilter: "all", force: true });
    expect(h.rows()).toHaveLength(0);
    expect(filteredRow()?.pinned).toBe(true);
    const operation = h.sessions.patch(key, { pinned: false });
    expect(filteredRow()?.pinned).toBe(false);
    await expect(operation).rejects.toThrow("unpin rejected");
    expect(filteredRow()).toMatchObject({ pinned: true, pinnedAt: 7 });
  });

  it("rolls a failed unpin back to the pin an overlapping completion confirmed", async () => {
    const committed = createDeferred<unknown>();
    const rejected = createDeferred<unknown>();
    const h = pinFixture((call) => (call === 1 ? committed.promise : rejected.promise));
    await h.sessions.refresh({ force: true });
    const pin = h.sessions.patch(h.key, { pinned: true });
    const unpin = h.sessions.patch(h.key, { pinned: false });
    expect(h.pinned()).toBe(false);
    h.server.pinned = true;
    h.commit(committed);
    await expect(pin).resolves.toBeTruthy();
    expect(h.pinned()).toBe(false);
    rejected.reject(new Error("unpin rejected"));
    await expect(unpin).rejects.toThrow("unpin rejected");
    expect(h.pinned()).toBe(true);
    expect(h.sessions.state.error).toContain("unpin rejected");
  });
});
