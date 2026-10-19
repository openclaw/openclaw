// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import {
  acquireLease,
  boardClient,
  boardSnapshot,
  boardWidget,
  capabilities,
  mainTab,
  noCapabilities,
  registerBoardProviderLeaseCases,
} from "./provider.lease-cases.test-support.ts";
import {
  boardExists,
  boardProviderForSession,
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
} from "./provider.ts";
import type { BoardSnapshot } from "./types.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("board providers", () => {
  it("keeps generated canvas widget names distinct after normalization and truncation", () => {
    const longPrefix = "x".repeat(80);
    const names = [
      canvasWidgetNameForDocument("Foo"),
      canvasWidgetNameForDocument("foo"),
      canvasWidgetNameForDocument(`${longPrefix}-one`),
      canvasWidgetNameForDocument(`${longPrefix}-two`),
    ];

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names.every((name) => /^[a-z0-9][a-z0-9._-]*$/u.test(name))).toBe(true);
  });

  it("keeps the null provider chat-only", () => {
    const provider = boardProviderForSession({ sessionKey: "agent:main:plain" });

    expect(boardExists(provider.snapshot$.value)).toBe(false);
    expect(provider.snapshot$.value).toEqual({
      sessionKey: "agent:main:plain",
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });

  registerBoardProviderLeaseCases();

  it("dispatches newly authorized board actions after upgrading a read-only lease", async () => {
    const sessionKey = "agent:main:lease-scope-upgrade";
    const snapshot = {
      sessionKey,
      revision: 1,
      tabs: [mainTab],
      widgets: [
        boardWidget("pending-widget", {
          grantState: "pending" as const,
        }),
      ],
    };
    const client = {
      request: vi.fn(async () => snapshot) as never,
      addEventListener: vi.fn(() => () => {}),
    };
    const lease = acquireLease({ sessionKey }, client, noCapabilities);
    const approver = acquireLease({ sessionKey }, client, {
      canPinWidgets: false,
      canPinMcpApps: false,
      canMutate: false,
    });

    try {
      await waitForFast(() => expect(lease.provider.snapshot$.value).toEqual(snapshot));
      await expect(lease.provider.applyOps([])).rejects.toThrow();
      await expect(lease.provider.pinWidget({ docId: "cv-upgraded" })).rejects.toThrow();
      await expect(lease.provider.pinMcpApp({ viewId: "app-upgraded" })).rejects.toThrow();
      await expect(lease.provider.grant("pending-widget", "granted")).rejects.toThrow();
      expect(client.request).toHaveBeenCalledOnce();

      lease.update(client, true, capabilities);
      expect(approver.provider.canGrant).toBe(true);
      expect(approver.provider.canMutate).toBe(false);

      await expect(lease.provider.applyOps([])).resolves.toBeUndefined();
      await expect(lease.provider.pinWidget({ docId: "cv-upgraded" })).resolves.toBeUndefined();
      await expect(lease.provider.pinMcpApp({ viewId: "app-upgraded" })).resolves.toBeUndefined();
      await expect(lease.provider.grant("pending-widget", "granted")).resolves.toBeUndefined();
      expect(client.request).toHaveBeenCalledTimes(5);
      expect(client.request).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(client.request).toHaveBeenCalledWith("board.widget.put", {
        sessionKey,
        name: "canvas-cv-upgraded",
        content: { kind: "canvas-doc", docId: "cv-upgraded" },
      });
      expect(client.request).toHaveBeenCalledWith("board.widget.put", {
        sessionKey,
        name: mcpAppWidgetNameForViewId("app-upgraded"),
        content: { kind: "mcp-app", viewId: "app-upgraded" },
      });
      expect(client.request).toHaveBeenCalledWith("board.widget.grant", {
        sessionKey,
        name: "pending-widget",
        decision: "granted",
        revision: 1,
      });
      expect(client.addEventListener).toHaveBeenCalledOnce();

      lease.update(client, true, noCapabilities);
      expect(approver.provider.canGrant).toBe(true);
      expect(approver.provider.canMutate).toBe(false);

      await expect(lease.provider.applyOps([])).rejects.toThrow();
      await expect(lease.provider.pinWidget({ docId: "cv-upgraded" })).rejects.toThrow();
      await expect(lease.provider.pinMcpApp({ viewId: "app-upgraded" })).rejects.toThrow();
      await expect(lease.provider.grant("pending-widget", "granted")).rejects.toThrow();
      expect(client.request).toHaveBeenCalledTimes(5);
    } finally {
      lease.release();
      approver.release();
    }
  });

  it("reconnects concurrent board leases through the same cached gateway transport", async () => {
    const sessionKey = "agent:main:shared-lease-reconnect";
    const previousSnapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
    const nextSnapshot = { ...previousSnapshot, revision: 2 };
    const removePreviousListener = vi.fn();
    const removeNextListener = vi.fn();
    const previousClient = {
      request: vi.fn(async () => previousSnapshot) as never,
      addEventListener: vi.fn(() => removePreviousListener),
    };
    const nextClient = {
      request: vi.fn(async () => nextSnapshot) as never,
      addEventListener: vi.fn(() => removeNextListener),
    };
    const writer = acquireLease({ sessionKey }, previousClient, { canGrant: false });
    const approver = acquireLease({ sessionKey }, previousClient, {
      canPinWidgets: false,
      canPinMcpApps: false,
      canMutate: false,
    });
    const cached = boardProviderForSession({ sessionKey });

    try {
      await waitForFast(() => expect(writer.provider.snapshot$.value).toEqual(previousSnapshot));

      writer.update(nextClient, true, { ...capabilities, canGrant: false });

      await waitForFast(() => expect(writer.provider.snapshot$.value).toEqual(nextSnapshot));
      expect(approver.provider.snapshot$.value).toEqual(nextSnapshot);
      expect(boardProviderForSession({ sessionKey })).toBe(cached);
      expect(removePreviousListener).toHaveBeenCalledOnce();
      expect(nextClient.addEventListener).toHaveBeenCalledOnce();
      expect(nextClient.request).toHaveBeenCalledOnce();
      expect(approver.provider.canGrant).toBe(true);
      expect(approver.provider.canMutate).toBe(false);

      writer.release();
      expect(removeNextListener).not.toHaveBeenCalled();
      approver.release();
      expect(removeNextListener).toHaveBeenCalledOnce();
    } finally {
      writer.release();
      approver.release();
    }
  });

  it("shares one provider across equivalent main session keys", () => {
    expect(boardProviderForSession({ sessionKey: "main" })).toBe(
      boardProviderForSession({ sessionKey: "agent:main:main" }),
    );
  });

  it("does not preserve a stale ticket when a widget generation is recreated", async () => {
    const baseWidget = boardWidget("alpha");
    const initial = {
      sessionKey: "agent:main:generation",
      revision: 1,
      tabs: [mainTab],
      widgets: [
        {
          ...baseWidget,
          viewGeneration: "a".repeat(32),
          frameUrl: "/old-ticket",
        },
      ],
    };
    const recreated = {
      ...initial,
      revision: 2,
      widgets: [
        {
          ...baseWidget,
          viewGeneration: "b".repeat(32),
          frameUrl: "/replacement-ticket",
          sandboxUrl: "/mcp-app-sandbox",
        },
      ],
    };
    const renewed = {
      ...recreated,
      revision: 3,
      widgets: [{ ...recreated.widgets[0]!, frameUrl: "/renewed-ticket" }],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(recreated)
      .mockResolvedValueOnce(renewed);
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: "agent:main:generation" }, client);
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(initial));

    client.emit("board.changed", { sessionKey: "agent:main:generation", revision: 2 });

    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(2));
    expect(provider.widgetFrameUrl("alpha", 1)).toBe("/replacement-ticket");

    client.emit("board.changed", { sessionKey: "agent:main:generation", revision: 3 });
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(3));
    expect(provider.widgetFrameUrl("alpha", 1)).toBe("/renewed-ticket");
  });

  it("does not publish an activation snapshot older than a completed mutation", async () => {
    const activation = createDeferred<BoardSnapshot>();
    const stale = boardSnapshot("agent:main:stale", 1);
    const current = boardSnapshot("agent:main:stale", 2, { tabs: [mainTab] });
    const request = vi.fn((method: string) => {
      if (method === "board.get") {
        return activation.promise;
      }
      return Promise.resolve(current);
    });
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:stale" },
      boardClient(request),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));

    await provider.pinWidget({ docId: "cv-current" });
    expect(provider.snapshot$.value.revision).toBe(2);
    activation.resolve(stale);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(provider.snapshot$.value).toEqual(current);
  });

  it("preserves a newer deletion reset while an older refresh is in flight", async () => {
    const pendingIntermediate = createDeferred<BoardSnapshot>();
    const populated = boardSnapshot("agent:main:deleted-board", 5, { tabs: [mainTab] });
    const intermediate = { ...populated, revision: 6 };
    const deleted = boardSnapshot("agent:main:deleted-board", 0);
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(() => pendingIntermediate.promise)
      .mockResolvedValueOnce(deleted);
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: "agent:main:deleted-board" }, client);
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(populated));

    client.emit("board.changed", { sessionKey: "agent:main:deleted-board", revision: 6 });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    client.emit("board.changed", { sessionKey: "agent:main:deleted-board", revision: 7 });
    pendingIntermediate.resolve(intermediate);

    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(deleted));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("accepts a recreated board after a higher-revision deletion event", async () => {
    const stale = createDeferred<BoardSnapshot>();
    const populated = {
      sessionKey: "agent:main:recreated-board",
      revision: 5,
      tabs: [{ tabId: "old", title: "Old", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const deleted = boardSnapshot("agent:main:recreated-board", 0);
    const recreated = {
      sessionKey: "agent:main:recreated-board",
      revision: 1,
      tabs: [{ tabId: "new", title: "New", position: 0, chatDock: "left" as const }],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(recreated);
    const client = boardClient(request);
    const provider = new GatewayBoardProvider({ sessionKey: "agent:main:recreated-board" }, client);
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(populated));

    client.emit("board.changed", { sessionKey: "agent:main:recreated-board", revision: 6 });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    client.emit("board.changed", { sessionKey: "agent:main:recreated-board", revision: 1 });
    stale.resolve(deleted);

    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(recreated));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale empty response from an overlapping mutation", async () => {
    const older = createDeferred<BoardSnapshot>();
    const pendingNewer = createDeferred<BoardSnapshot>();
    const populated = boardSnapshot("agent:main:mutation-race", 5, { tabs: [mainTab] });
    const newer = { ...populated, revision: 6 };
    const deleted = boardSnapshot("agent:main:mutation-race", 0);
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => pendingNewer.promise);
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:mutation-race" },
      boardClient(request),
    );
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(populated));

    const olderMutation = provider.applyOps([{ kind: "tab_delete", tabId: "main" }]);
    const newerMutation = provider.applyOps([
      { kind: "tab_update", tabId: "main", chatDock: "left" },
    ]);
    pendingNewer.resolve(newer);
    await newerMutation;
    older.resolve(deleted);
    await olderMutation;

    expect(provider.snapshot$.value).toEqual(newer);
  });

  it("does not resurrect a board from a refresh started before deletion", async () => {
    const pendingRefresh = createDeferred<BoardSnapshot>();
    const deletion = createDeferred<BoardSnapshot>();
    const populated = boardSnapshot("agent:main:refresh-reset-race", 5, { tabs: [mainTab] });
    const staleRefresh = { ...populated, revision: 6 };
    const deleted = boardSnapshot("agent:main:refresh-reset-race", 0);
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "board.get") {
        getCount += 1;
        if (getCount === 1) {
          return Promise.resolve(populated);
        }
        if (getCount === 2) {
          return pendingRefresh.promise;
        }
        return Promise.resolve(deleted);
      }
      return deletion.promise;
    });
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:refresh-reset-race" },
      boardClient(request),
    );
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(populated));

    const refresh = provider.activate();
    await vi.waitFor(() => expect(getCount).toBe(2));
    const deleteMutation = provider.applyOps([{ kind: "tab_delete", tabId: "main" }]);
    deletion.resolve(deleted);
    await deleteMutation;
    pendingRefresh.resolve(staleRefresh);
    await refresh;

    expect(provider.snapshot$.value).toEqual(deleted);
    expect(getCount).toBe(3);
  });

  it("preserves a widget ticket refresh across a superseding mutation", async () => {
    const pendingRefresh = createDeferred<BoardSnapshot>();
    const initial = {
      sessionKey: "agent:main:ticket-race",
      revision: 1,
      tabs: [mainTab],
      widgets: [
        boardWidget("alpha", {
          frameUrl: "/old-ticket",
        }),
      ],
    };
    const mutation = {
      ...initial,
      revision: 2,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/mutation-ticket" }],
    };
    const reminted = {
      ...mutation,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/reminted-ticket" }],
    };
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method !== "board.get") {
        return Promise.resolve(mutation);
      }
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(initial);
      }
      if (getCount === 2) {
        return pendingRefresh.promise;
      }
      return Promise.resolve(reminted);
    });
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:ticket-race" },
      boardClient(request),
    );
    await waitForFast(() => expect(provider.snapshot$.value).toEqual(initial));

    const refresh = provider.refreshWidgetFrame("alpha");
    await vi.waitFor(() => expect(getCount).toBe(2));
    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);
    pendingRefresh.resolve({
      ...mutation,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/superseded-ticket" }],
    });
    await refresh;

    expect(getCount).toBe(3);
    expect(provider.widgetFrameUrl("alpha", 1)).toBe("/reminted-ticket");
  });
});
