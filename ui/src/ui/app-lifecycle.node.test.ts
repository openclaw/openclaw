// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { handleDisconnected, handleUpdated } from "./app-lifecycle.ts";
import { loadChatComposerSnapshot } from "./chat/composer-persistence.ts";
import { configureWorkboardPolling, getWorkboardState } from "./controllers/workboard.ts";
import type { ChatQueueItem } from "./ui-types.ts";

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connectGeneration: 0,
    connected: true,
    routeId: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    localMediaPreviewRoots: [],
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "main",
    chatMessage: "",
    chatQueue: [] as ChatQueueItem[],
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    sessionsChangedReloadTimer: null as number | ReturnType<typeof globalThis.setTimeout> | null,
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

type ComposerPersistHost = ReturnType<typeof createHost> & {
  chatComposerPersistTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
};

function createComposerPersistHost(): ComposerPersistHost {
  return createHost() as ComposerPersistHost;
}

describe("handleDisconnected", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops and clears gateway client on teardown", () => {
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    removeSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("clears pending session reload timers on teardown", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const host = createHost();
    const pendingReload = vi.fn();
    host.sessionsChangedReloadTimer = globalThis.setTimeout(() => pendingReload(), 1_000);

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(host.sessionsChangedReloadTimer).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(pendingReload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stops Workboard polling timers on teardown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const host = createHost();
    const client = {
      request: vi.fn(async () => ({ cards: [], statuses: ["todo"] })),
    };
    getWorkboardState(host).autoRefreshIntervalMs = 5000;
    configureWorkboardPolling({
      host,
      client: client as never,
      enabled: true,
    });

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(client.request).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stops Workboard lifecycle refresh state on teardown", () => {
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const host = createHost();
    const state = getWorkboardState(host);
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshRetryAt = Date.now() + 5000;
    state.lifecycleTaskRefreshError = "task refresh unavailable";
    state.lifecycleConfirmedTaskIds.add("task-1");
    state.lifecycleTaskConfirmationStartedAt = Date.now();

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lifecycleConfirmedTaskIds.size).toBe(0);
    expect(state.lifecycleTaskConfirmationStartedAt).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("handleUpdated", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("debounces draft-only composer persistence", () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    const host = createHost();
    host.chatMessage = "typing without blocking input";

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatMessage", ""]]),
    );

    expect(loadChatComposerSnapshot(host, "main")).toBeNull();

    vi.advanceTimersByTime(199);
    expect(loadChatComposerSnapshot(host, "main")).toBeNull();

    vi.advanceTimersByTime(1);
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "typing without blocking input",
      queue: [],
    });
  });

  it("flushes delayed draft persistence on teardown", () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const host = createHost();
    host.chatMessage = "save before close";

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatMessage", ""]]),
    );
    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "save before close",
      queue: [],
    });
    vi.advanceTimersByTime(200);
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "save before close",
      queue: [],
    });
  });

  it("persists queue changes immediately and clears delayed draft persistence", () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    const host = createComposerPersistHost();
    host.chatMessage = "draft with queued work";

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatMessage", ""]]),
    );
    host.chatQueue = [{ id: "queued-1", text: "next prompt", createdAt: 1 }];
    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatQueue", []]]),
    );

    expect(host.chatComposerPersistTimer).toBeNull();
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "draft with queued work",
      queue: [{ id: "queued-1", text: "next prompt", createdAt: 1 }],
    });
  });

  it("persists drafts immediately when the active session changes", () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    const host = createComposerPersistHost();
    host.chatMessage = "draft before new chat";

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatMessage", ""]]),
    );
    host.sessionKey = "agent:main:new-session";
    host.chatMessage = "draft restored into new chat";
    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([
        ["sessionKey", "main"],
        ["chatMessage", ""],
      ]),
    );

    expect(host.chatComposerPersistTimer).toBeNull();
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "draft before new chat",
      queue: [],
    });
    expect(loadChatComposerSnapshot(host, "agent:main:new-session")).toEqual({
      draft: "draft restored into new chat",
      queue: [],
    });
  });

  it("flushes delayed draft persistence when only the session changes", () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    const host = createComposerPersistHost();
    host.chatMessage = "draft from old session";

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["chatMessage", ""]]),
    );
    host.sessionKey = "agent:main:other";
    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["sessionKey", "main"]]),
    );

    expect(host.chatComposerPersistTimer).toBeNull();
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "draft from old session",
      queue: [],
    });
    expect(loadChatComposerSnapshot(host, "agent:main:other")).toBeNull();
    vi.advanceTimersByTime(200);
    expect(loadChatComposerSnapshot(host, "agent:main:other")).toBeNull();
    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "draft from old session",
      queue: [],
    });
  });

  it("persists chat draft and queue changes before chat refresh short-circuits", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const host = createHost();
    host.chatManualRefreshInFlight = true;
    host.chatMessage = "survive refresh";
    host.chatQueue = [{ id: "queued-1", text: "next prompt", createdAt: 1 }];

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([
        ["chatMessage", ""],
        ["chatQueue", []],
      ]),
    );

    expect(loadChatComposerSnapshot(host, "main")).toEqual({
      draft: "survive refresh",
      queue: [{ id: "queued-1", text: "next prompt", createdAt: 1 }],
    });
  });
});
