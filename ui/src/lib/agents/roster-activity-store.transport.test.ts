/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createRosterFixture,
  rosterResult as snapshot,
  rosterRow,
} from "./roster-activity-store.test-support.ts";

const cleanup: Array<() => void> = [];

async function subscribedFixture() {
  const f = fixture();
  const detach = f.subscribe();
  await vi.advanceTimersByTimeAsync(0);
  return Object.assign(f, { detach });
}

function mockVisibility(initial: DocumentVisibilityState) {
  let current = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => current);
  return async (next: DocumentVisibilityState) => {
    current = next;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  };
}

function expectWindow(f: ReturnType<typeof fixture>, reads: number, preview: string) {
  expect(f.requests).toHaveLength(reads);
  expect(f.store.snapshot.cards[0]?.preview).toBe(preview);
}

function fixture() {
  const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
  const protocol = new GatewayPendingRequests({ createRequestId: () => "roster", nowMs: Date.now });
  const respond = (id: string, payload: unknown) =>
    protocol.handleResponse({ type: "res", id, ok: true, payload });
  function send(frame: string) {
    const request = JSON.parse(frame);
    if (request.method === "sessions.list" && request.params.archived === "all") {
      requests.push(request);
      return;
    }
    const payload =
      request.method === "sessions.subscribe"
        ? { subscribed: true }
        : request.method === "sessions.list"
          ? snapshot("", false, [])
          : request.method === "sessions.groups.list"
            ? { groups: [], sectionOrder: [] }
            : undefined;
    if (payload === undefined) {
      throw new Error(`Unexpected RPC: ${request.method}`);
    }
    respond(request.id, payload);
  }
  const client = createTestGatewayClient((...args) => protocol.request({ send }, ...args));
  const base = createRosterFixture(client);
  const notify = vi.fn();
  cleanup.push(() => {
    base.sessions.dispose();
    protocol.flush(new Error("fixture closed"));
  });
  return {
    ...base,
    notify,
    get keys() {
      return base.store.snapshot.result?.sessions.map(({ key }) => key);
    },
    subscribe() {
      const detach = base.store.subscribe(notify);
      cleanup.push(detach);
      return detach;
    },
    requests,
    invalidate() {
      base.emit({ agentId: "main", key: "agent:main:new" });
    },
    async respond(index: number, preview: string, hasMore = false, keys = ["agent:main:main"]) {
      const rows = keys.map((key) => rosterRow({ key, lastMessagePreview: preview }));
      respond(requests[index]!.id, snapshot(preview, hasMore, rows));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["client", "account", "recovery scope"])(
  "keeps loaded roster activity through a blip and retires it with %s identity",
  async (change) => {
    const f = fixture();
    const hello = gatewayHelloForMethods(
      ["sessions.list", "sessions.subscribe", "sessions.groups.list"],
      ["operator.read"],
    );
    hello.auth!.recoveryScope = "alice-scope";
    f.source.publish({
      ...f.source.gateway.snapshot,
      hello,
      selfUser: { id: "alice", name: "Alice" },
    });
    f.subscribe();
    await vi.advanceTimersByTimeAsync(0);
    await f.respond(0, "Retained work");
    await vi.advanceTimersByTimeAsync(0);
    f.source.publish({ ...f.source.gateway.snapshot, phase: "reconnecting" });
    expect(f.store.snapshot.cards[0]?.preview).toBe("Retained work");
    f.source.publish({ ...f.source.gateway.snapshot, phase: "connected" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Retained work");
    await f.respond(1, "Fresh work");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Fresh work");
    f.source.publish({
      ...f.source.gateway.snapshot,
      ...(change === "client"
        ? { phase: "reconnecting" as const, client: createTestGatewayClient(async () => ({})) }
        : change === "account"
          ? { selfUser: { id: "bob", name: "Bob" } }
          : {
              selfUser: undefined,
              hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
            }),
    });
    expect(f.store.snapshot.result).toBeNull();
    expect(f.store.snapshot.membershipReady).toBe(false);
    if (change === "client") {
      expect(f.store.snapshot.cards).toEqual([]);
    } else {
      expect(f.store.snapshot.cards).toMatchObject([
        { id: "main", preview: undefined, activeNow: false, unreadCount: 0, lastActiveAt: 0 },
      ]);
    }
  },
);

it.each(["operator.sessions.read", "operator.sessions.write"])(
  "loads and retains roster activity with %s until fresh access loss",
  async (scope) => {
    const f = fixture();
    const hello = gatewayHelloForMethods(
      ["sessions.list", "sessions.subscribe", "sessions.groups.list"],
      [scope],
    );
    f.source.publish({ ...f.source.gateway.snapshot, hello });
    f.subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    await f.respond(0, "Permitted activity");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Permitted activity");

    f.source.publish({ ...f.source.gateway.snapshot, phase: "reconnecting", hello: null });
    expect(f.store.snapshot.cards[0]?.preview).toBe("Permitted activity");
    f.source.publish({ ...f.source.gateway.snapshot, phase: "connected", hello });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Permitted activity");
    await f.respond(1, "Fresh permitted activity");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Fresh permitted activity");

    f.source.publish({
      ...f.source.gateway.snapshot,
      hello: { ...hello, auth: { ...hello.auth!, scopes: [] } },
    });
    expect(f.store.snapshot.result).toBeNull();
    expect(f.store.snapshot.cards).toEqual([]);
    expect(f.store.snapshot.membershipReady).toBe(false);
  },
);

it.each(["pending", "settled"] as const)(
  "keeps the %s roster window through recap-only updates",
  async (phase) => {
    const f = await subscribedFixture();
    if (phase === "settled") {
      await f.respond(0, "Current activity");
    }
    f.emit({
      sessionKey: "agent:main:main",
      agentId: "main",
      reason: "activity-summary",
      session: snapshot("Current activity").sessions[0],
    });
    await vi.advanceTimersByTimeAsync(250);
    if (phase === "pending") {
      await f.respond(0, "Current activity");
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expectWindow(f, 1, "Current activity");
    expect(f.store.snapshot.loading).toBe(false);

    f.invalidate();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.requests).toHaveLength(2);
    await f.respond(1, "Refreshed membership");
    expect(f.store.snapshot.cards[0]?.preview).toBe("Refreshed membership");
  },
);

it.each([
  { issued: "before", settled: false },
  { issued: "before", settled: true },
  { issued: "after", settled: false },
  { issued: "after", settled: true },
] as const)(
  "reconciles metadata issued $issued the roster read (settled: $settled) without losing membership changes",
  async ({ issued, settled }) => {
    const f = fixture();
    let reconcile = issued === "before" ? f.sessions.captureReconcile() : undefined;
    f.subscribe();
    await vi.advanceTimersByTimeAsync(0);
    reconcile ??= f.sessions.captureReconcile();
    if (settled) {
      await f.respond(0, "Listed membership");
    }
    reconcile({
      ...snapshot("Selected session metadata").sessions[0]!,
      sessionId: "main-session",
      updatedAt: 1,
    });
    if (!settled) {
      await f.respond(0, "Listed membership");
    }
    await vi.advanceTimersByTimeAsync(15_000);
    if (issued === "after") {
      expect(f.requests).toHaveLength(2);
      await f.respond(1, "Listed membership");
    }
    const reads = issued === "before" ? 1 : 2;
    expect(f.requests).toHaveLength(reads);
    expect(f.store.snapshot.membershipReady).toBe(true);
    expect(f.keys).toEqual(["agent:main:main"]);

    f.invalidate();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.requests).toHaveLength(reads + 1);
    await f.respond(reads, "New membership", false, ["agent:main:main", "agent:main:new"]);
    expect(f.keys).toEqual(["agent:main:main", "agent:main:new"]);
  },
);

it.each([
  { name: "repeated invalidations", delays: Array.from({ length: 8 }, () => 1_000), afterReply: 0 },
  { name: "a newer debounce", delays: [5_000, 0], afterReply: 5_000 },
])("coalesces $name behind one correlated request", async ({ delays, afterReply }) => {
  const f = await subscribedFixture();
  for (const delay of delays) {
    f.invalidate();
    if (delay > 0) {
      await vi.advanceTimersByTimeAsync(delay);
    }
  }
  expect(f.requests).toHaveLength(1);
  await f.respond(0, "Held window", true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.params.offset).toBeUndefined();
  await f.respond(1, "Fresh window");
  await vi.advanceTimersByTimeAsync(afterReply);
  expectWindow(f, 2, "Fresh window");
  expect(f.store.snapshot.loading).toBe(false);
});

it("keeps concurrent filter windows separate through out-of-order replies", async () => {
  const f = await subscribedFixture();
  for (const involvingMe of [true, false, true]) {
    f.store.setInvolvingMe(involvingMe);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.params).toMatchObject({ involvingMe: true, limit: 100, archived: "all" });
  await f.respond(1, "Current filter");
  await f.respond(0, "Old filter", true);
  expectWindow(f, 2, "Current filter");
});

it.each([false, true])("retains transport across detach (reattach: %s)", async (reattach) => {
  const f = await subscribedFixture();
  f.detach();
  expect(f.store.snapshot.cards).toEqual([]);
  if (reattach) {
    f.subscribe();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(f.requests).toHaveLength(1);
  await f.respond(0, "Retired page", true);
  expect(f.requests).toHaveLength(reattach ? 2 : 1);
  if (reattach) {
    expect(f.requests[1]?.params.offset).toBe(1);
    await f.respond(1, "Remounted page", false, ["agent:main:next"]);
    expect(f.keys).toEqual(["agent:main:main", "agent:main:next"]);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Retired page");
  } else {
    expect(f.store.snapshot.cards).toEqual([]);
  }
});

it.each(["same-client", "detached", "replacement-client"])(
  "rejects late replies across a %s reconnect",
  async (cause) => {
    const f = await subscribedFixture();
    const detached = cause === "detached";
    if (detached) {
      f.detach();
    }
    if (cause === "replacement-client") {
      const previousClient = f.source.gateway.snapshot.client!;
      const client = createTestGatewayClient((...args) => previousClient.request(...args));
      f.source.publish({ ...f.source.gateway.snapshot, client });
      void f.store.refresh();
    } else {
      f.source.publish({ ...f.source.gateway.snapshot, phase: "reconnecting" });
      f.source.publish({ ...f.source.gateway.snapshot, phase: "connected" });
    }
    if (detached) {
      f.subscribe();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.params.offset).toBeUndefined();
    await f.respond(1, "Current connection");
    f.notify.mockClear();
    await f.respond(0, "Old connection", true);
    expectWindow(f, 2, "Current connection");
    expect(f.notify).not.toHaveBeenCalled();
  },
);

it.each(["initially hidden", "reply hidden", "reply visible"])(
  "defers hidden work: %s",
  async (phase) => {
    const initialHidden = phase === "initially hidden";
    const replyHidden = phase === "reply hidden";
    const show = mockVisibility(initialHidden ? "hidden" : "visible");
    const f = fixture();
    f.subscribe();
    if (!initialHidden) {
      await vi.advanceTimersByTimeAsync(0);
      await show("hidden");
    }
    for (let i = 0; i < 8; i++) {
      f.invalidate();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(f.requests).toHaveLength(initialHidden ? 0 : 1);
    if (replyHidden) {
      await f.respond(0, "Hidden page", true);
      expect(f.requests).toHaveLength(1);
    }
    await show("visible");
    if (!initialHidden && !replyHidden) {
      expect(f.requests).toHaveLength(1);
      await f.respond(0, "Revoked page", true);
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const read = initialHidden ? 0 : 1;
    expect(f.requests).toHaveLength(read + 1);
    if (!initialHidden) {
      expect(f.requests[read]?.params.offset).toBeUndefined();
    }
    await f.respond(read, "Current window");
    expect(f.store.snapshot.cards[0]?.preview).toBe("Current window");
  },
);
