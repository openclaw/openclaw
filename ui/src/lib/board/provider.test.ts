// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderForSession,
  canvasWidgetNameForDocument,
  createNullBoardProvider,
  mcpAppWidgetNameForViewId,
} from "./provider.ts";
import type { BoardProvider } from "./provider.ts";
import type { BoardSnapshot, BoardWidget } from "./types.ts";
import { remainingBoardWidgetTicketTtlMs } from "./widget-ticket-lifetime.ts";
const KEY = "agent:main:board";
const mainTab = { tabId: "main", title: "Main", position: 0, chatDock: "right" as const };
const capabilities = { canMutate: true, canGrant: true, canPinWidgets: true, canPinMcpApps: true };
const noCapabilities = {
  canMutate: false,
  canGrant: false,
  canPinWidgets: false,
  canPinMcpApps: false,
};
const approvalOnly = { ...noCapabilities, canGrant: true };
const widget = (overrides: Partial<BoardWidget> = {}): BoardWidget => ({
  name: "alpha",
  tabId: "main",
  contentKind: "html",
  sizeW: 6,
  sizeH: 4,
  position: 0,
  grantState: "none",
  revision: 1,
  ...overrides,
});
const snapshot = (revision = 1, overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  sessionKey: KEY,
  revision,
  tabs: [mainTab],
  widgets: [],
  ...overrides,
});
const called = (mock: unknown, count = 1) =>
  vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
function boardClient(handler: GatewayRequestHandler = async () => snapshot()) {
  const requests = vi.fn(handler);
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const addEventListener = vi.fn((listener: (event: GatewayEventFrame) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  return {
    request: requests as never,
    requests,
    listeners,
    addEventListener,
    emit(event: string, payload: unknown) {
      for (const listener of listeners) {
        listener({ type: "event", event, payload });
      }
    },
  };
}
function provider(
  client: ReturnType<typeof boardClient>,
  connected = true,
  session = { sessionKey: KEY },
) {
  const p = new GatewayBoardProvider(session, client, connected);
  onTestFinished(() => p.dispose());
  return p;
}
function fixture(initial = snapshot(), connected = true) {
  const client = boardClient(async () => initial);
  const p = provider(client, connected);
  return {
    client,
    p,
    request: client.requests,
    initial,
    changed: (revision: number) => client.emit("board.changed", { sessionKey: KEY, revision }),
  };
}
const loaded = (p: BoardProvider, expected: BoardSnapshot) =>
  vi.waitFor(() => expect(p.snapshot$.value).toEqual(expected));
function acquire(
  client: ReturnType<typeof boardClient>,
  caps = capabilities,
  scope?: object,
  persist?: (snapshot: BoardSnapshot | null, receivedAtMs: number) => void,
) {
  const lease = acquireBoardProviderForSession(
    { sessionKey: KEY },
    client,
    true,
    caps.canPinWidgets,
    caps.canPinMcpApps,
    caps.canMutate,
    caps.canGrant,
    scope,
    persist,
  );
  onTestFinished(() => lease.release());
  return lease;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("board leases", () => {
  it("persists authoritative receipts for late and surviving leases", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let response: BoardSnapshot | null = snapshot();
    const client = boardClient(async () => {
      if (!response) {
        throw new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access removed" });
      }
      return response;
    });
    const scope = {};
    const lease = (persist?: (value: BoardSnapshot | null, at: number) => void) =>
      acquire(client, { ...noCapabilities, canMutate: true }, scope, persist);
    await lease().provider.refreshWidgetFrame("chart");
    now = 2000;
    const firstPersist = vi.fn(),
      survivingPersist = vi.fn();
    const first = lease(firstPersist),
      surviving = lease(survivingPersist);
    expect(firstPersist).toHaveBeenCalledExactlyOnceWith(response, 1000);
    expect(survivingPersist).toHaveBeenCalledExactlyOnceWith(response, 1000);
    first.release();
    now = 3000;
    response = snapshot(2);
    await surviving.provider.applyOps([]);
    expect(firstPersist).toHaveBeenCalledTimes(1);
    expect(survivingPersist).toHaveBeenLastCalledWith(response, 3000);
    now = 4000;
    response = null;
    await surviving.provider.refreshWidgetFrame("chart");
    expect(survivingPersist).toHaveBeenLastCalledWith(null, 4000);
    surviving.release();
    now = 5000;
    const afterDenial = vi.fn();
    lease(afterDenial);
    expect(afterDenial).toHaveBeenCalledExactlyOnceWith(null, 4000);
  });
  it("keeps null providers chat-only", () => {
    const p = createNullBoardProvider(KEY);
    expect(boardExists(p.snapshot$.value)).toBe(false);
    expect(p.snapshot$.value).toEqual(snapshot(0, { tabs: [] }));
  });
  it("looks up only leased providers and aliases the main session", () => {
    expect(boardProviderForSession({ sessionKey: "main" })).toBeUndefined();
    const lease = acquireBoardProviderForSession({ sessionKey: "main" }, boardClient(), false);
    onTestFinished(() => lease.release());
    const cached = boardProviderForSession({ sessionKey: "main" });
    expect(cached?.snapshot$).toBe(lease.provider.snapshot$);
    expect(cached).toBe(boardProviderForSession({ sessionKey: "agent:main:main" }));
    expect(boardProviderForSession({ sessionKey: "main" }, false)).toBeUndefined();
    lease.release();
    expect(boardProviderForSession({ sessionKey: "main" })).toBeUndefined();
  });
  it("keeps normalized and truncated canvas names distinct and valid", () => {
    const long = "x".repeat(80);
    const names = ["Foo", "foo", long + "-one", long + "-two"].map(canvasWidgetNameForDocument);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/u.test(name))).toBe(
      true,
    );
  });
  it("retains reconnect data but isolates a replacement presentation from retiring leases", async () => {
    const initial = snapshot(),
      refreshed = createDeferred<BoardSnapshot>();
    const c = boardClient();
    c.requests.mockResolvedValueOnce(initial).mockReturnValue(refreshed.promise);
    const scope = {},
      first = acquire(c, capabilities, scope),
      retiring = acquire(c, capabilities, scope);
    await loaded(first.provider, initial);
    expect(retiring.provider.snapshot$).toBe(first.provider.snapshot$);
    first.update(c, false, capabilities);
    expect(first.provider.snapshot$.value).toEqual(initial);
    expect(first.provider.canMutate).toBe(false);
    await expect(first.provider.applyOps([])).rejects.toThrow("mutation unavailable");
    first.update(c, true, capabilities);
    expect(first.provider.snapshot$.value).toEqual(initial);
    const replacement = acquire(c, capabilities, {});
    expect(replacement.provider.hasLoadedSnapshot).toBe(false);
    expect(replacement.provider.snapshot$.value.revision).toBe(0);
    expect(first.provider.canMutate).toBe(false);
    expect(retiring.provider.canGrant).toBe(false);
    await expect(retiring.provider.applyOps([])).rejects.toThrow("mutation unavailable");
    retiring.update(c, true, capabilities);
    refreshed.resolve(snapshot(2));
    await loaded(replacement.provider, snapshot(2));
    expect(retiring.provider.snapshot$.value).toEqual(initial);
    first.release();
    retiring.release();
    expect(replacement.provider.canMutate).toBe(true);
    expect(c.requests).not.toHaveBeenCalledWith("board.update", expect.anything());
  });
  it("prevents retired clients from rolling back shared leases", async () => {
    const initial = snapshot(),
      current = snapshot(2),
      future = snapshot(3);
    const old = boardClient(async () => initial),
      next = boardClient(async () => current);
    const last = boardClient(async () => future);
    const writer = acquire(old, { ...capabilities, canGrant: false }),
      stale = acquire(old, approvalOnly);
    const cached = boardProviderForSession({ sessionKey: KEY });
    await loaded(writer.provider, initial);
    const retiredListener = [...old.listeners][0];
    expect(retiredListener).toBeDefined();
    writer.update(next, true, { ...capabilities, canGrant: false });
    await loaded(writer.provider, current);
    expect(stale.provider.snapshot$.value).toEqual(current);
    expect([old.listeners.size, next.listeners.size]).toEqual([0, 1]);
    expect(boardProviderForSession({ sessionKey: KEY })).toBe(cached);
    expect(stale.provider).toMatchObject(approvalOnly);
    stale.update(old, false, capabilities);
    expect(stale.provider.snapshot$.value).toEqual(current);
    expect(next.listeners.size).toBe(1);
    retiredListener?.({
      type: "event",
      event: "board.changed",
      payload: { sessionKey: KEY, revision: 4 },
    });
    await Promise.resolve();
    expect(next.requests).toHaveBeenCalledOnce();
    await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
    expect(next.requests).toHaveBeenCalledWith("board.update", { sessionKey: KEY, ops: [] });
    writer.update(next, false, capabilities);
    writer.update(next, true, capabilities);
    await called(next.requests, 3);
    stale.update(last, true, capabilities);
    await loaded(writer.provider, future);
    expect([next.listeners.size, last.listeners.size]).toEqual([0, 1]);
    await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
    expect(last.requests).toHaveBeenCalledWith("board.update", { sessionKey: KEY, ops: [] });
    writer.release();
    expect(last.listeners.size).toBe(1);
    stale.release();
    expect(last.listeners.size).toBe(0);
  });
  it("isolates lease capabilities through upgrades and release", async () => {
    const initial = snapshot(1, { widgets: [widget({ grantState: "pending" })] });
    const c = boardClient(async () => initial);
    const dashboard = acquire(c, noCapabilities),
      approver = acquire(c, approvalOnly);
    await loaded(dashboard.provider, initial);
    const actions = (p: BoardProvider) => [
      () => p.applyOps([]),
      () => p.pinWidget({ docId: "cv" }),
      () => p.pinMcpApp({ viewId: "app" }),
      () => p.grant("alpha", "granted"),
    ];
    const check = async (p: BoardProvider, permitted: readonly boolean[]) => {
      for (const [index, run] of actions(p).entries()) {
        if (permitted[index]) {
          await expect(run()).resolves.toBeUndefined();
        } else {
          await expect(run()).rejects.toThrow();
        }
      }
    };
    await check(dashboard.provider, [false, false, false, false]);
    for (const allowed of [true, false]) {
      dashboard.update(c, true, allowed ? capabilities : noCapabilities);
      expect(dashboard.provider).toMatchObject(allowed ? capabilities : noCapabilities);
      expect(approver.provider).toMatchObject(approvalOnly);
      await check(dashboard.provider, [allowed, allowed, allowed, allowed]);
    }
    expect(c.requests).toHaveBeenCalledWith("board.widget.put", {
      sessionKey: KEY,
      name: mcpAppWidgetNameForViewId("app"),
      content: { kind: "mcp-app", viewId: "app" },
    });
    await check(approver.provider, [false, false, false, true]);
    const writer = acquire(c, { ...capabilities, canGrant: false });
    await expect(writer.provider.grant("alpha", "granted")).rejects.toThrow();
    await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
    writer.release();
    approver.release();
    expect(c.listeners.size).toBe(1);
    const requestCount = c.requests.mock.calls.length;
    dashboard.release();
    dashboard.release();
    await expect(dashboard.provider.applyOps([])).rejects.toThrow();
    expect(c.requests).toHaveBeenCalledTimes(requestCount);
    expect(c.listeners.size).toBe(0);
    expect(dashboard.provider.snapshot$.value).toEqual(initial);
  });
});
describe("board snapshots and refreshes", () => {
  it.each([null, { widgets: [{}] }, { tabs: [{}] }])(
    "ignores malformed cache %j but permits a valid restore",
    (raw) => {
      const f = fixture(snapshot(), false);
      f.p.restoreSnapshot(raw === null ? null : { ...f.initial, ...raw }, Date.now());
      expect(f.p.hasLoadedSnapshot).toBe(false);
      expect(f.p.snapshot$.value.widgets).toEqual([]);
      f.p.restoreSnapshot(f.initial, Date.now());
      expect(f.p.snapshot$.value).toEqual(f.initial);
    },
  );
  it("rejects foreign cache and retains only confirmed MCP apps", () => {
    const cached = snapshot(1, {
      widgets: (["pending", "rejected", "granted"] as const).map((grantState) =>
        widget({ name: grantState, contentKind: "mcp-app", grantState }),
      ),
    });
    const f = fixture(cached, false);
    f.p.restoreSnapshot({ ...cached, sessionKey: "agent:foreign:cache" }, Date.now());
    expect(f.p.hasLoadedSnapshot).toBe(false);
    f.p.restoreSnapshot(cached, Date.now());
    expect(f.p.snapshot$.value.widgets.map((w) => w.name)).toEqual(["granted"]);
  });
  it("restores offline layout without renewing TTL and ignores hydration after live revalidation", async () => {
    vi.useFakeTimers();
    const now = Date.now(),
      pending = createDeferred<BoardSnapshot>();
    const cached = snapshot(1, {
      widgets: [widget({ viewTicket: "cached", viewTicketTtlMs: 30_000 })],
    });
    const f = fixture(cached, false),
      persist = vi.fn();
    f.request.mockReturnValue(pending.promise);
    f.p.subscribeCacheSnapshot(persist);
    f.p.restoreSnapshot(cached, now - 5_000);
    expect(f.p.snapshot$.value.widgets[0]?.viewTicketTtlMs).toBe(25_000);
    expect(f.request).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    f.p.attachClient(f.client, true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("board.get", { sessionKey: KEY });
    pending.resolve(snapshot(2));
    await f.p.activate();
    expect(f.p.snapshot$.value.widgets).toEqual([]);
    expect(persist).toHaveBeenCalledOnce();
    f.p.restoreSnapshot(cached, now);
    expect(f.p.snapshot$.value.widgets).toEqual([]);
  });
  it("retires denied warm content and prevents late cache hydration", async () => {
    const f = fixture(snapshot(), false),
      persist = vi.fn();
    f.request.mockRejectedValue(
      new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access removed" }),
    );
    f.p.subscribeCacheSnapshot(persist);
    f.p.restoreSnapshot(f.initial, Date.now());
    await f.p.activate();
    f.p.attachClient(boardClient(f.request), true);
    await f.p.activate();
    expect(f.p.snapshot$.value.tabs).toEqual([]);
    expect(persist).toHaveBeenCalledWith(null, expect.any(Number));
    f.p.restoreSnapshot(f.initial, Date.now());
    expect(f.p.snapshot$.value.tabs).toEqual([]);
  });
  it.each(["UNAVAILABLE", "FORBIDDEN"] as const)(
    "stops definitive %s polling until reconnect",
    async (code) => {
      vi.useFakeTimers();
      const f = fixture(),
        recovered = snapshot(2);
      const error = new GatewayProtocolRequestError({
        code,
        message: "Unavailable",
        retryable: false,
      });
      f.request.mockRejectedValue(error);
      await vi.advanceTimersByTimeAsync(0);
      f.changed(2);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.p.snapshot$.value).toEqual(
        code === "FORBIDDEN" ? snapshot(0, { tabs: [] }) : f.initial,
      );
      expect(f.p.loadError$.value).toBe(error.message);
      f.request.mockResolvedValue(recovered);
      f.p.attachClient(f.client, false);
      f.p.attachClient(f.client, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.request).toHaveBeenCalledTimes(3);
      expect(f.p.snapshot$.value).toEqual(recovered);
      expect(f.p.loadError$.value).toBeNull();
    },
  );
  it.each([false, true])(
    "pauses outage retries and preserves a joining manual refresh (%s)",
    async (manual) => {
      vi.useFakeTimers();
      let connected = true;
      const c = boardClient(() =>
        connected
          ? Promise.resolve(snapshot())
          : Promise.reject(new Error("gateway not connected")),
      );
      c.requests.mockRejectedValueOnce(new Error("temporarily unavailable"));
      if (manual) {
        c.requests.mockRejectedValueOnce(new Error("gateway not connected"));
      }
      const p = provider(c);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.requests).toHaveBeenCalledOnce();
      connected = false;
      p.attachClient(c, false);
      if (manual) {
        const refresh = p.refreshWidgetFrame("status");
        await vi.advanceTimersByTimeAsync(0);
        await refresh;
      }
      await vi.advanceTimersByTimeAsync(31_000);
      expect(c.requests).toHaveBeenCalledTimes(manual ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
      connected = true;
      p.attachClient(c, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.requests).toHaveBeenCalledTimes(manual ? 3 : 2);
      expect(p.snapshot$.value).toEqual(snapshot());
    },
  );
  it("does not reread a queued manual refresh after disconnect", async () => {
    vi.useFakeTimers();
    const first = createDeferred<BoardSnapshot>(),
      second = createDeferred<BoardSnapshot>();
    const c = boardClient();
    c.requests.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p = provider(c),
      refresh = p.refreshWidgetFrame("status");
    c.emit("board.changed", { sessionKey: KEY, revision: 2 });
    p.attachClient(c, false);
    first.resolve(snapshot());
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(c.requests).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    p.attachClient(c, true);
    second.resolve(snapshot(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.requests).toHaveBeenCalledTimes(2);
    expect(p.snapshot$.value).toEqual(snapshot(2));
  });
  it("coalesces same-tick widget refreshes", async () => {
    const pending = createDeferred<BoardSnapshot>(),
      c = boardClient(() => pending.promise);
    const p = provider(c, false);
    const refreshes = ["first", "second", "third"].map((name) => p.refreshWidgetFrame(name));
    pending.resolve(snapshot());
    await Promise.all(refreshes);
    await Promise.resolve();
    expect(c.requests).toHaveBeenCalledExactlyOnceWith("board.get", { sessionKey: KEY });
  });
  it.each(["delete", "recreate", "mutate-delete", "mutate-ticket", "write", "client"] as const)(
    "discards stale results after %s supersession",
    async (cause) => {
      const pending = createDeferred<BoardSnapshot>();
      const empty = snapshot(0, { tabs: [] });
      const ticket = cause === "mutate-ticket";
      const initial = snapshot(5, { widgets: [widget({ frameUrl: "/old" })] });
      const final = ticket
        ? snapshot(6, { widgets: [widget({ frameUrl: "/fresh" })] })
        : cause === "recreate"
          ? snapshot(1, { tabs: [{ ...mainTab, tabId: "new", chatDock: "left" }] })
          : cause === "delete" || cause === "mutate-delete"
            ? empty
            : snapshot(6);
      const mutation = ticket
        ? snapshot(6, { widgets: [widget({ frameUrl: "/mutation" })] })
        : final;
      const f = fixture(initial);
      f.request
        .mockReturnValueOnce(pending.promise)
        .mockImplementation(async (method) => (method === "board.update" ? mutation : final));
      await loaded(f.p, initial);
      const writing = cause === "write" || cause === "client";
      if (cause === "delete" || cause === "recreate") {
        f.changed(6);
      }
      const work = writing
        ? f.p.applyOps([{ kind: "tab_delete", tabId: "main" }])
        : ticket
          ? f.p.refreshWidgetFrame("alpha")
          : f.p.activate();
      await called(f.request, 2);
      if (cause === "client") {
        f.p.attachClient(
          boardClient(async () => final),
          true,
        );
        await loaded(f.p, final);
      } else if (cause === "delete" || cause === "recreate") {
        f.changed(cause === "recreate" ? 1 : 7);
      } else {
        await f.p.applyOps([
          ticket || cause === "write"
            ? { kind: "tab_update", tabId: "main", chatDock: "left" }
            : { kind: "tab_delete", tabId: "main" },
        ]);
      }
      pending.resolve(
        cause === "recreate" || cause === "write"
          ? empty
          : ticket
            ? snapshot(6, { widgets: [widget({ frameUrl: "/superseded" })] })
            : snapshot(7),
      );
      await work;
      await loaded(f.p, final);
      expect(f.request).toHaveBeenCalledTimes(
        cause === "client" ? 2 : cause.startsWith("mutate-") ? 4 : 3,
      );
      if (ticket) {
        expect(f.p.widgetFrameUrl("alpha", 1)).toBe("/fresh");
      }
    },
  );
  it("uses replacement-generation tickets and renews only the current generation", async () => {
    const original = widget({ viewGeneration: "a".repeat(32), frameUrl: "/old-ticket" });
    const replacement = {
      ...original,
      viewGeneration: "b".repeat(32),
      frameUrl: "/replacement-ticket",
      sandboxUrl: "/mcp-app-sandbox",
    };
    const f = fixture(snapshot(1, { widgets: [original] }));
    f.request
      .mockResolvedValueOnce(snapshot(2, { widgets: [replacement] }))
      .mockResolvedValueOnce(
        snapshot(3, { widgets: [{ ...replacement, frameUrl: "/renewed-ticket" }] }),
      );
    await loaded(f.p, f.initial);
    for (const [revision, url] of [
      [2, "/replacement-ticket"],
      [3, "/renewed-ticket"],
    ] as const) {
      f.changed(revision);
      await vi.waitFor(() => expect(f.p.snapshot$.value.revision).toBe(revision));
      expect(f.p.widgetFrameUrl("alpha", 1)).toBe(url);
    }
  });
  it("preserves minted view metadata and expiring receipts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const plain = widget({ grantState: "pending" });
    const minted = {
      ...plain,
      frameUrl: "/frame",
      viewTicket: "ticket",
      viewTicketTtlMs: 60_000,
      viewGeneration: "a".repeat(32),
      sandboxUrl: "https://sandbox.example/host",
      sandboxPort: 18_790,
      sandboxOrigin: "https://sandbox.example:18790",
    };
    const layout = snapshot(2, { widgets: [{ ...plain, sizeW: 8 }] });
    const grant = snapshot(3, { widgets: [{ ...layout.widgets[0]!, grantState: "granted" }] });
    const f = fixture(snapshot(1, { widgets: [minted] }));
    f.request.mockResolvedValueOnce(layout).mockResolvedValueOnce(grant);
    const persisted = vi.fn<(value: BoardSnapshot | null, receivedAtMs: number) => void>();
    f.p.subscribeCacheSnapshot(persisted);
    const restored = fixture(snapshot(), false).p;
    await f.p.activate();
    vi.setSystemTime(51_000);
    await f.p.applyOps([{ kind: "widget_resize", name: "alpha", sizeW: 8, sizeH: 4 }]);
    await f.p.grant("alpha", "granted");
    expect(f.p.snapshot$.value.widgets[0]).toEqual({ ...minted, sizeW: 8, grantState: "granted" });
    expect(remainingBoardWidgetTicketTtlMs(f.p.snapshot$.value.widgets[0]!)).toBe(10_000);
    const [cached, at] = persisted.mock.lastCall!;
    expect([cached?.widgets[0]?.viewTicketTtlMs, at]).toEqual([10_000, 51_000]);
    vi.setSystemTime(71_000);
    restored.restoreSnapshot(cached, at);
    expect(restored.snapshot$.value.widgets[0]?.viewTicketTtlMs).toBe(0);
    expect(remainingBoardWidgetTicketTtlMs(restored.snapshot$.value.widgets[0]!)).toBe(0);
    f.request.mockResolvedValueOnce(grant);
    await f.p.applyOps([]);
    expect(persisted).toHaveBeenLastCalledWith(null, 71_000);
    expect(f.p.snapshot$.value.widgets[0]?.viewTicketTtlMs).toBe(60_000);
    expect(remainingBoardWidgetTicketTtlMs(f.p.snapshot$.value.widgets[0]!)).toBe(0);
  });
  it("keeps scoped RPC and event identities", async () => {
    const session = { sessionKey: "global", agentId: "work" },
      key = "agent:work:global";
    const first = createDeferred<BoardSnapshot>(),
      second = createDeferred<BoardSnapshot>();
    const empty = snapshot(0, { sessionKey: key, tabs: [] });
    const pinned = snapshot(1, {
      sessionKey: key,
      widgets: [
        widget({
          name: "canvas-cv-1",
          instanceId: "canvas-instance",
          frameUrl: "/frame",
        }),
      ],
    });
    const c = boardClient();
    c.requests
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(pinned);
    const p = provider(c, false, session);
    p.attachClient(c, true);
    const refresh = p.refreshWidgetFrame("status");
    c.emit("board.changed", { sessionKey: key, revision: 1 });
    first.resolve(empty);
    await called(c.requests, 2);
    second.resolve(pinned);
    await refresh;
    expect(p.snapshot$.value).toEqual(pinned);
    expect(c.requests).toHaveBeenCalledWith("board.get", session);
    const command = vi.fn(),
      focus = { kind: "focus_tab", tabId: "main" };
    p.events.subscribe(command);
    const ops = [{ kind: "tab_update", tabId: "main", chatDock: "left" }] as const;
    await p.applyOps([...ops]);
    await p.grant("canvas-cv-1", "granted");
    const title = "📌 Pinned ".repeat(20).trim();
    await p.pinWidget({ docId: "cv-1", title });
    await p.pinMcpApp({
      viewId: "mcp-app-source",
      name: "mcp-app-opaque",
      title: "App status",
      tabId: "main",
      size: "md",
      after: "canvas-cv-1",
    });
    c.emit("board.changed", { sessionKey: "agent:other:global", revision: 99 });
    c.emit("board.command", { sessionKey: "agent:other:global", command: focus });
    expect(command).not.toHaveBeenCalled();
    c.emit("board.command", { sessionKey: key, command: focus });
    const rpc = (method: string, params: Record<string, unknown>) =>
      expect(c.requests).toHaveBeenCalledWith(method, { ...session, ...params });
    rpc("board.update", { ops });
    rpc("board.widget.grant", {
      name: "canvas-cv-1",
      decision: "granted",
      revision: 1,
      instanceId: "canvas-instance",
    });
    rpc("board.widget.put", {
      name: "canvas-cv-1",
      title: Array.from(title).slice(0, 80).join(""),
      content: { kind: "canvas-doc", docId: "cv-1" },
    });
    rpc("board.widget.put", {
      name: "mcp-app-opaque",
      title: "App status",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
      placement: { tabId: "main", size: "md", after: "canvas-cv-1" },
    });
    expect(c.requests).toHaveBeenCalledTimes(6);
    expect(p.snapshot$.value).toEqual(pinned);
    c.emit("board.changed", { sessionKey: key, revision: 2 });
    await called(c.requests, 7);
    c.emit("board.command", { ...session, command: focus });
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledWith({ sessionKey: key, command: focus });
  });
});
describe("MCP App leases", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "" });
  });
  const app = () =>
    snapshot(1, {
      widgets: [widget({ name: "server-app", contentKind: "mcp-app", instanceId: "app-instance" })],
    });
  const read = (p: BoardProvider, refresh = false) =>
    refresh ? p.refreshWidgetAppView("server-app", 1) : p.widgetAppView("server-app", 1);
  const ready = (viewId: string) => ({ status: "ready", viewId });
  const view = (viewId: string) => ({ viewId, expiresAtMs: Date.now() + 60_000 });
  it.each([{ sessionKey: KEY }, { sessionKey: "global", agentId: "work" }])(
    "deduplicates $sessionKey app leases until refresh or reconnect",
    async (session) => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const initial = { ...app(), sessionKey: session.agentId ? "agent:work:global" : KEY };
      let leases = 0;
      const c = boardClient(async (method) => {
        if (method === "board.get") {
          return initial;
        }
        if (method === "board.widget.appView") {
          leases += 1;
          return { viewId: "mcp-app-" + leases, expiresAtMs: leases === 1 ? 10_000 : 20_000 };
        }
        throw new Error("unexpected method: " + method);
      });
      const p = provider(c, true, session);
      await loaded(p, initial);
      await expect(read(p)).resolves.toMatchObject(ready("mcp-app-1"));
      expect(c.requests).toHaveBeenCalledWith("board.widget.appView", {
        ...session,
        name: "server-app",
        revision: 1,
        instanceId: "app-instance",
      });
      now = 6_000;
      await expect(read(p)).resolves.toMatchObject(ready("mcp-app-1"));
      await expect(read(p, true)).resolves.toMatchObject(ready("mcp-app-2"));
      expect(
        c.requests.mock.calls.filter(([method]) => method === "board.widget.appView"),
      ).toHaveLength(2);
      p.attachClient(c, false);
      p.attachClient(c, true);
      await expect(read(p)).resolves.toMatchObject(ready("mcp-app-3"));
    },
  );
  it("keys same-name cache entries by instance", async () => {
    const cache = new BoardMcpAppViewCache(),
      w = widget({ contentKind: "mcp-app", instanceId: "a" });
    const request = vi.fn().mockResolvedValueOnce(view("a")).mockResolvedValueOnce(view("b"));
    await expect(cache.resolve(w, request, false)).resolves.toHaveProperty("viewId", "a");
    await expect(cache.resolve({ ...w, instanceId: "b" }, request, false)).resolves.toHaveProperty(
      "viewId",
      "b",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(["replacement", "reconnect", "disposal"] as const)(
    "rejects pending app leases after %s",
    async (transition) => {
      const initial = app(),
        pending = createDeferred<ReturnType<typeof view>>();
      const c = boardClient((method) =>
        method === "board.get" ? Promise.resolve(initial) : pending.promise,
      );
      const p = provider(c);
      await loaded(p, initial);
      const resolving = read(p);
      await vi.waitFor(() =>
        expect(c.requests).toHaveBeenCalledWith("board.widget.appView", expect.any(Object)),
      );
      if (transition === "replacement") {
        p.attachClient(
          boardClient(async () => initial),
          true,
        );
      } else if (transition === "reconnect") {
        p.attachClient(c, false);
        p.attachClient(c, true);
      } else {
        p.dispose();
      }
      pending.resolve(view("retired"));
      await expect(resolving).resolves.toEqual({ status: "stale" });
    },
  );
  it("contains re-mint failures and retries on demand", async () => {
    const f = fixture(app());
    f.request
      .mockRejectedValueOnce(new Error("origin transcript pruned"))
      .mockResolvedValueOnce(view("restored"));
    await loaded(f.p, f.initial);
    await expect(read(f.p)).resolves.toEqual({ status: "stale" });
    await expect(read(f.p, true)).resolves.toMatchObject(ready("restored"));
  });
});
