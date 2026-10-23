/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import { createSignal, flush, Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import { openSlot } from "./sidebar-layout.ts";
import "../../components/board/board-view.tsx";

type BoardTestPane = HTMLElement & {
  context: ApplicationContext;
  state: ChatPageHost;
  sessionSnapshotStore?: SessionSnapshotStore;
  hydrateStoredChatSnapshot: (state: ChatPageHost, sessionKey: string) => void;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => ResolvedBoardView;
  renderBoardPanel: (
    board: ResolvedBoardView,
    layout: ChatPageHost["sidebarLayout"],
  ) => Parameters<typeof ChatBoardPanel>[0] | null;
  releaseBoardProviderLease: () => void;
};

type BoardSnapshot = BoardProvider["snapshot$"]["value"];

function createGatewayBoardPane(sessionKey: string) {
  const snapshot: BoardSnapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
  const request = vi.fn<(method: string, params: unknown) => Promise<BoardSnapshot>>(
    async () => snapshot,
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const { pane: base } = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
  const pane = base as unknown as BoardTestPane;
  pane.state.sessionKey = sessionKey;
  Reflect.set(pane, "boardProviderLifecycleConnected", true);
  pane.context = {
    ...pane.context,
    gateway: {
      ...pane.context.gateway,
      snapshot: { client, phase: "connected", hello: { features: { methods: ["board.get"] } } },
    },
  } as unknown as ApplicationContext;
  // The board custom element must be connected before its loading state commits.
  const container = document.body.appendChild(document.createElement("div"));
  const layout = openSlot({ columns: [] }, "dashboard");
  const [content, setContent] = createSignal<Parameters<typeof ChatBoardPanel>[0] | null>(null);
  const mounted = mountSolid(
    () => <Show when={content()}>{(current) => <ChatBoardPanel {...current()} />}</Show>,
    { container },
  );
  return {
    pane,
    request,
    snapshot,
    container,
    draw: () => {
      setContent(pane.renderBoardPanel(pane.resolveBoardView(), layout));
      flush();
    },
    cleanup: () => {
      mounted.unmount();
      container.remove();
      pane.releaseBoardProviderLease();
    },
  };
}

describe("chat pane board loading states", () => {
  it("hydrates a full cached transcript while its board waits for connect dispatch", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const sessionKey = "agent:main:dispatch-cached-board";
    const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
    const dispatch = createDeferred();
    const transcript = createDeferred();
    request.mockReturnValue(createDeferred<BoardSnapshot>().promise);
    pane.state.settings = {
      ...pane.state.settings,
      gatewayUrl: pane.context.gateway.connection.gatewayUrl,
    };
    Object.assign(pane.state.client!, {
      recoveryScope: "admitted-account",
      recoveryScopeReady: true,
      initialConnectSent: dispatch.promise,
    });
    pane.context.gateway.snapshot.phase = "connecting";
    Reflect.set(pane, "sessionKey", sessionKey);
    const store = new SessionSnapshotStore(pane.state.chatMessagesBySession);
    pane.sessionSnapshotStore = store;
    const messages = [{ role: "assistant", content: "Retained conversation" }];
    store.write(resolveChatSnapshotKey(pane.state, { sessionKey }), {
      messages,
      sessionId: "retained-session",
      pagination: { hasMore: false },
      board: { snapshot, receivedAtMs: Date.now() },
    });
    try {
      await store.flush();
      const provider = pane.resolveBoardProvider();
      pane.hydrateStoredChatSnapshot(pane.state, sessionKey);
      const hydration = chatHistoryRequests(pane.state).initialSnapshotHydration!;
      hydration.complete = transcript.resolve;
      await transcript.promise;
      expect(pane.state.chatMessages).toEqual(messages);
      expect(provider.hasLoadedSnapshot).toBe(false);
      dispatch.resolve();
      await hydration.promise;
      expect(provider.hasLoadedSnapshot).toBe(true);
      expect(provider.snapshot$.value).toEqual(snapshot);
    } finally {
      dispatch.resolve();
      cleanup();
      await clearStoredChatSnapshots();
      vi.unstubAllGlobals();
    }
  });

  it("hydrates the transcript without mounting an invalid persisted board", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const sessionKey = "agent:main:invalid-cached-board";
    const { pane, request, container, draw, cleanup } = createGatewayBoardPane(sessionKey);
    const response = createDeferred<BoardSnapshot>();
    request.mockReturnValue(response.promise);
    pane.state.settings = {
      ...pane.state.settings,
      gatewayUrl: pane.context.gateway.connection.gatewayUrl,
    };
    Object.assign(pane.state.client!, {
      recoveryScope: "admitted-account",
      recoveryScopeReady: true,
    });
    Reflect.set(pane, "sessionKey", sessionKey);
    const store = new SessionSnapshotStore(pane.state.chatMessagesBySession);
    pane.sessionSnapshotStore = store;
    const messages = [{ role: "assistant", content: "Retained conversation" }];
    store.write(resolveChatSnapshotKey(pane.state, { sessionKey }), {
      messages,
      sessionId: "retained-session",
      pagination: { hasMore: false },
      board: {
        snapshot: { sessionKey, revision: 1, tabs: [], widgets: [{}] },
        receivedAtMs: Date.now(),
      },
    });
    try {
      await store.flush();
      const provider = pane.resolveBoardProvider();
      pane.hydrateStoredChatSnapshot(pane.state, sessionKey);
      await chatHistoryRequests(pane.state).initialSnapshotHydration?.promise;
      expect(pane.state.chatMessages).toEqual(messages);
      expect(provider.hasLoadedSnapshot).toBe(false);
      draw();
      await container.querySelector("openclaw-board-view")?.updateComplete;
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
    } finally {
      cleanup();
      await clearStoredChatSnapshots();
      vi.unstubAllGlobals();
    }
  });

  it("persists a board acquired before pane state exists after transcript hydration", async () => {
    const sessionKey = "agent:main:warm-persistence";
    const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
    const response = createDeferred<typeof snapshot>();
    const hydration = createDeferred();
    pane.state.settings = { ...pane.state.settings, gatewayUrl: "wss://gateway.example" };
    request.mockReturnValue(response.promise);
    chatHistoryRequests(pane.state).initialSnapshotHydration = {
      sessionKey,
      connected: false,
      promise: hydration.promise,
    };
    const state = pane.state;
    Reflect.set(pane, "sessionKey", sessionKey);
    Reflect.set(pane, "state", undefined);
    const provider = pane.resolveBoardProvider();
    Reflect.set(pane, "state", state);
    Object.assign(pane.state.client!, {
      recoveryScope: "admitted-account",
      recoveryScopeReady: true,
    });
    response.resolve(snapshot);
    try {
      await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
      expect(
        readChatSessionSnapshot(pane.state.chatMessagesBySession, pane.state, { sessionKey }),
      ).toBeNull();
      cacheChatSessionSnapshot(
        pane.state.chatMessagesBySession,
        pane.state,
        { sessionKey },
        {
          messages: [{ role: "assistant", content: "Retained conversation" }],
          sessionId: "retained-session",
          pagination: { hasMore: false },
        },
      );
      hydration.resolve();
      await hydration.promise;
      await Promise.resolve();
      const cached = readChatSessionSnapshot(pane.state.chatMessagesBySession, pane.state, {
        sessionKey,
      });
      expect(cached?.messages).toEqual([{ role: "assistant", content: "Retained conversation" }]);
      expect(cached?.board?.snapshot).toEqual(snapshot);
    } finally {
      hydration.resolve();
      cleanup();
    }
  });

  it("discards a retired lease's deferred cache write after a newer board arrives", async () => {
    const sessionKey = "agent:main:retired-board-cache";
    const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
    const response = createDeferred<BoardSnapshot>();
    const hydration = createDeferred();
    pane.state.settings = { ...pane.state.settings, gatewayUrl: "wss://gateway.example" };
    Object.assign(pane.state.client!, {
      recoveryScope: "admitted-account",
      recoveryScopeReady: true,
    });
    const history = chatHistoryRequests(pane.state);
    history.initialSnapshotHydration = { sessionKey, connected: false, promise: hydration.promise };
    request.mockReturnValueOnce(response.promise);
    const retired = pane.resolveBoardProvider();
    try {
      response.resolve(snapshot);
      await response.promise;
      expect(retired.hasLoadedSnapshot).toBe(true);
      pane.releaseBoardProviderLease();
      history.initialSnapshotHydration = undefined;
      const newer = { ...snapshot, revision: 2 };
      const newerResponse = Promise.resolve(newer);
      request.mockReturnValueOnce(newerResponse);
      pane.resolveBoardProvider();
      await newerResponse;
      const readBoard = () =>
        readChatSessionSnapshot(pane.state.chatMessagesBySession, pane.state, { sessionKey })?.board
          ?.snapshot;
      expect(readBoard()).toEqual(newer);
      hydration.resolve();
      await hydration.promise;
      expect(readBoard()).toEqual(newer);
    } finally {
      hydration.resolve();
      cleanup();
    }
  });

  it("shows a board skeleton until the snapshot arrives", async () => {
    const sessionKey = "agent:main:pending-board";
    const { pane, request, snapshot, container, draw, cleanup } =
      createGatewayBoardPane(sessionKey);
    let complete!: (snapshot: BoardSnapshot) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const provider = pane.resolveBoardProvider();
    try {
      draw();
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-board-view")).not.toBeNull(),
      );
      const view = container.querySelector("openclaw-board-view")!;
      await view.updateComplete;
      const skeleton = container.querySelector("openclaw-panel-loading-skeleton");
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("board");
      expect(skeleton?.getAttribute("role")).toBe("status");
      expect(container.textContent?.trim()).toBe("");
      complete(snapshot);
      await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
      draw();
      await view.updateComplete;
      await view.updateComplete;
      expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(container.querySelector("openclaw-board-view")).toBe(view);
    } finally {
      cleanup();
    }
  });

  it("replaces the skeleton with a styled alert when the snapshot fails to load", async () => {
    const { pane, request, container, draw, cleanup } = createGatewayBoardPane(
      "agent:main:failing-board",
    );
    request.mockRejectedValueOnce(new Error("gateway offline"));
    const provider = pane.resolveBoardProvider();
    try {
      await vi.waitFor(() => expect(provider.loadError$.value).toBeTruthy());
      draw();
      const alert = container.querySelector('[role="alert"]');
      expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(alert?.classList.contains("board-session-surface__state--error")).toBe(true);
      expect(alert?.textContent).toContain("gateway offline");
    } finally {
      cleanup();
    }
  });
});
