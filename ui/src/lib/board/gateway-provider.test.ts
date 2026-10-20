// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import {
  boardClient,
  boardSnapshot,
  boardWidget,
  mainTab,
} from "./provider.lease-cases.test-support.ts";
import type { BoardProvider } from "./provider.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gateway board provider lifecycle", () => {
  it("discards mutation responses from a replaced gateway client", async () => {
    const pending = createDeferred<BoardProvider["snapshot$"]["value"]>();
    const oldClient = boardClient(vi.fn(() => pending.promise));
    const current = boardSnapshot("agent:main:replacement", 3);
    const newClient = boardClient(vi.fn(async () => current));
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:replacement" },
      oldClient,
      false,
    );
    const mutation = provider.applyOps([]);

    provider.attachClient(newClient, true);
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(current));
    pending.resolve({ ...current, revision: 4 });
    await mutation;

    expect(provider.snapshot$.value).toEqual(current);
  });

  it.each(["UNAVAILABLE", "FORBIDDEN"] as const)(
    "stops definitive %s polling until reconnect without discarding its snapshot",
    async (code) => {
      vi.useFakeTimers();
      const initial = boardSnapshot("agent:main:unavailable", 1);
      const recovered = { ...initial, revision: 2 };
      const unavailable = new GatewayProtocolRequestError({
        code,
        message: "Session dashboard unavailable",
        retryable: false,
      });
      const request = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(unavailable);
      const client = boardClient(request);
      const provider = new GatewayBoardProvider({ sessionKey: initial.sessionKey }, client);
      const changed = () =>
        client.emit("board.changed", {
          sessionKey: initial.sessionKey,
          revision: recovered.revision,
        });
      try {
        await vi.advanceTimersByTimeAsync(0);
        changed();
        await vi.advanceTimersByTimeAsync(61_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(provider.snapshot$.value).toEqual(initial);
        expect(provider.loadError$.value).toBe(unavailable.message);

        request.mockResolvedValue(recovered);
        provider.attachClient(client, false);
        provider.attachClient(client, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(3);
        expect(provider.snapshot$.value).toEqual(recovered);
        expect(provider.loadError$.value).toBeNull();
      } finally {
        provider.dispose();
      }
    },
  );

  it("pauses board retries during an outage and refreshes once after reconnect", async () => {
    vi.useFakeTimers();
    let connected = true;
    const snapshot = boardSnapshot("agent:main:paused-reconnect", 1);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockImplementation(async () => {
        if (!connected) {
          throw new Error("gateway not connected");
        }
        return snapshot;
      });
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    connected = false;
    provider.attachClient(client, false);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    connected = true;
    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
    provider.dispose();
  });

  it("preserves a manual offline refresh that joins an existing retry loop", async () => {
    vi.useFakeTimers();
    const snapshot = boardSnapshot("agent:main:coalesced-offline-widget-refresh", 1);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValue(snapshot);
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    provider.attachClient(client, false);
    const refresh = provider.refreshWidgetFrame("status");
    await vi.advanceTimersByTimeAsync(0);
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(3);
    expect(provider.snapshot$.value).toEqual(snapshot);
    provider.dispose();
  });

  it("does not reread a queued manual refresh after its gateway disconnects", async () => {
    vi.useFakeTimers();
    const initial = boardSnapshot("agent:main:offline-queued-refresh", 1);
    const changed = { ...initial, revision: 2 };
    const first = createDeferred<typeof initial>();
    const second = createDeferred<typeof initial>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: initial.sessionKey }, client, true);
    const refresh = provider.refreshWidgetFrame("status");

    client.emit("board.changed", { sessionKey: initial.sessionKey, revision: changed.revision });
    provider.attachClient(client, false);
    first.resolve(initial);
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    provider.attachClient(client, true);
    second.resolve(changed);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(changed);
    provider.dispose();
  });

  it("coalesces same-tick widget refreshes into one in-flight board.get", async () => {
    const snapshot = boardSnapshot("agent:main:coalesced", 1);
    const pending = createDeferred<typeof snapshot>();
    const request = vi.fn(() => pending.promise);
    const provider = new GatewayBoardProvider(
      { sessionKey: snapshot.sessionKey },
      boardClient(request),
      false,
    );

    const refreshes = [
      provider.refreshWidgetFrame("first"),
      provider.refreshWidgetFrame("second"),
      provider.refreshWidgetFrame("third"),
    ];
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(snapshot);
    await Promise.all(refreshes);
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("board.get", { sessionKey: snapshot.sessionKey });
  });

  it.each([
    { session: { sessionKey: "global", agentId: "work" }, acknowledgedKey: "agent:work:global" },
  ])(
    "rereads $session when board.changed precedes its first acknowledgment",
    async ({ session, acknowledgedKey }) => {
      const initial = boardSnapshot(acknowledgedKey, 1);
      const changed = { ...initial, revision: 2 };
      const first = createDeferred<typeof initial>();
      const second = createDeferred<typeof initial>();
      const request = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const client = boardClient(request);
      const provider = new GatewayBoardProvider(session, client, false);
      provider.attachClient(client, true);

      const refresh = provider.refreshWidgetFrame("status");
      client.emit("board.changed", { sessionKey: initial.sessionKey, revision: changed.revision });
      first.resolve(initial);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      second.resolve(changed);
      await refresh;

      expect(provider.snapshot$.value.revision).toBe(changed.revision);
    },
  );

  it("preserves minted view metadata across layout and grant mutation snapshots", async () => {
    const plainWidget = boardWidget("alpha", { grantState: "pending" });
    const widget = {
      ...plainWidget,
      frameUrl: "/ticketed-frame",
      viewTicket: "view-ticket",
      viewTicketTtlMs: 60_000,
      viewGeneration: "a".repeat(32),
      sandboxUrl: "https://sandbox.example/host",
      sandboxPort: 18_790,
      sandboxOrigin: "https://sandbox.example:18790",
    };
    const initial = {
      sessionKey: "agent:main:mutation-view-contract",
      revision: 1,
      tabs: [mainTab],
      widgets: [widget],
    };
    const layoutMutation = {
      ...initial,
      revision: 2,
      widgets: [{ ...plainWidget, sizeW: 8 }],
    };
    const grantMutation = {
      ...layoutMutation,
      revision: 3,
      widgets: [{ ...layoutMutation.widgets[0]!, grantState: "granted" as const }],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(layoutMutation)
      .mockResolvedValueOnce(grantMutation);
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:mutation-view-contract" },
      boardClient(request),
    );
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(initial));

    await provider.applyOps([{ kind: "widget_resize", name: "alpha", sizeW: 8, sizeH: 4 }]);
    await provider.grant("alpha", "granted");

    expect(provider.snapshot$.value.widgets[0]).toEqual({
      ...widget,
      sizeW: 8,
      grantState: "granted",
    });
  });

  it.each([
    { session: { sessionKey: "global", agentId: "work" }, acknowledgedKey: "agent:work:global" },
  ])(
    "preserves $session through mutations and acknowledged board events",
    async ({ session, acknowledgedKey }) => {
      const empty = { sessionKey: acknowledgedKey, revision: 0, tabs: [], widgets: [] };
      const pinned = {
        sessionKey: acknowledgedKey,
        revision: 1,
        tabs: [mainTab],
        widgets: [
          boardWidget("canvas-cv-1", { instanceId: "canvas-instance", frameUrl: "/frame" }),
        ],
      };
      let getCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "board.get") {
          getCount += 1;
          return getCount === 1 ? empty : pinned;
        }
        return pinned;
      });
      const client = boardClient(request);
      const provider = new GatewayBoardProvider(session, client);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", session));
      const command = vi.fn();
      provider.events.subscribe(command);

      await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);
      await provider.grant("canvas-cv-1", "granted");
      const longTitle = "📌 Pinned ".repeat(20).trim();
      await provider.pinWidget({ docId: "cv-1", title: longTitle });
      await provider.pinMcpApp({
        viewId: "mcp-app-source",
        name: "mcp-app-opaque",
        title: "App status",
        tabId: "main",
        size: "md",
        after: "canvas-cv-1",
      });
      client.emit("board.changed", { sessionKey: "agent:other:global", revision: 99 });
      client.emit("board.command", {
        sessionKey: "agent:other:global",
        command: { kind: "focus_tab", tabId: "main" },
      });
      expect(command).not.toHaveBeenCalled();
      client.emit("board.command", {
        sessionKey: acknowledgedKey,
        command: { kind: "focus_tab", tabId: "main" },
      });

      expect(request).toHaveBeenCalledWith("board.update", {
        ...session,
        ops: [{ kind: "tab_update", tabId: "main", chatDock: "left" }],
      });
      expect(request).toHaveBeenCalledWith("board.widget.grant", {
        ...session,
        name: "canvas-cv-1",
        decision: "granted",
        revision: 1,
        instanceId: "canvas-instance",
      });
      expect(request).toHaveBeenCalledWith("board.widget.put", {
        ...session,
        name: "canvas-cv-1",
        title: Array.from(longTitle).slice(0, 80).join(""),
        content: { kind: "canvas-doc", docId: "cv-1" },
      });
      expect(request).toHaveBeenCalledWith("board.widget.put", {
        ...session,
        name: "mcp-app-opaque",
        title: "App status",
        content: { kind: "mcp-app", viewId: "mcp-app-source" },
        placement: { tabId: "main", size: "md", after: "canvas-cv-1" },
      });
      expect(request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(1);
      expect(provider.snapshot$.value).toEqual(pinned);
      client.emit("board.changed", { sessionKey: acknowledgedKey, revision: 2 });
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(2),
      );
      client.emit("board.command", { ...session, command: { kind: "focus_tab", tabId: "main" } });
      expect(command).toHaveBeenCalledTimes(2);
      expect(command).toHaveBeenCalledWith({
        sessionKey: acknowledgedKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      provider.dispose();
    },
  );
});
