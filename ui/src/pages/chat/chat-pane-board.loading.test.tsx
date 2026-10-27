import { expectDefined } from "@openclaw/normalization-core";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { createTestChatPane, mountBoardPanel } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
/* @vitest-environment jsdom */
import { writeSnapshotFixture } from "./session-snapshot.test-support.ts";
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
type Cleanup = { before?: () => void; after?: () => Promise<void> };
const transcript: ChatSessionSnapshot = {
  messages: [{ role: "assistant", content: "Retained conversation" }],
  sessionId: "retained-session",
  pagination: { hasMore: false },
};

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
  const mounted = mountBoardPanel(pane, openSlot({ columns: [] }, "dashboard"), container);
  const cleanup: Cleanup = {};
  onTestFinished(async () => {
    cleanup.before?.();
    mounted.unmount();
    container.remove();
    pane.releaseBoardProviderLease();
    await cleanup.after?.();
  });
  return {
    pane,
    request,
    snapshot,
    container,
    cleanup,
    draw: mounted.draw,
  };
}

function admitCache(pane: BoardTestPane, gatewayUrl = pane.context.gateway.connection.gatewayUrl) {
  pane.state.settings = { ...pane.state.settings, gatewayUrl };
  Object.assign(pane.state.client!, {
    recoveryScope: "admitted-account",
    recoveryScopeReady: true,
  });
}

async function persistBoard(pane: BoardTestPane, snapshot: unknown, cleanup: Cleanup) {
  admitCache(pane);
  Reflect.set(pane, "sessionKey", pane.state.sessionKey);
  vi.stubGlobal("indexedDB", new IDBFactory());
  cleanup.after = async () => {
    await clearStoredChatSnapshots();
    vi.unstubAllGlobals();
  };
  const store = new SessionSnapshotStore(pane.state.chatMessagesBySession);
  pane.sessionSnapshotStore = store;
  writeSnapshotFixture(
    store,
    resolveChatSnapshotKey(pane.state, { sessionKey: pane.state.sessionKey }),
    {
      ...transcript,
      board: { snapshot, receivedAtMs: Date.now() },
    },
  );
  await store.flush();
  return store;
}

it.each([false, true])(
  "paints saved rows and board while the socket cannot open (route pending: %s)",
  async (routePending) => {
    const sessionKey = "agent:main:dispatch-cached-board";
    const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
    const dispatch = createDeferred();
    cleanup.before = () => {
      dispatch.resolve();
      vi.useRealTimers();
    };
    request.mockReturnValue(createDeferred<BoardSnapshot>().promise);
    Object.assign(pane.state.client!, {
      initialConnectSent: dispatch.promise,
    });
    pane.context.gateway.snapshot.phase = "connecting";
    Reflect.set(pane, "routeResolutionPending", routePending);
    const store = await persistBoard(pane, snapshot, cleanup);
    const provider = pane.resolveBoardProvider();
    const reading = vi.spyOn(store, "read");
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    pane.hydrateStoredChatSnapshot(pane.state, sessionKey);
    const hydration = chatHistoryRequests(pane.state).initialSnapshotHydration!;
    await expectDefined(reading.mock.results[0], "snapshot read").value;
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.state.chatMessages).toEqual(transcript.messages);
    expect(provider.hasLoadedSnapshot).toBe(true);
    await vi.runAllTimersAsync();
    await hydration.promise;
    expect(pane.state.chatMessages).toEqual(transcript.messages);
    expect(provider.hasLoadedSnapshot).toBe(true);
    expect(provider.snapshot$.value).toEqual(snapshot);
  },
);

it("hydrates the transcript without mounting an invalid persisted board", async () => {
  const sessionKey = "agent:main:invalid-cached-board";
  const { pane, request, container, draw, cleanup } = createGatewayBoardPane(sessionKey);
  const response = createDeferred<BoardSnapshot>();
  request.mockReturnValue(response.promise);
  await persistBoard(pane, { sessionKey, revision: 1, tabs: [], widgets: [{}] }, cleanup);
  const provider = pane.resolveBoardProvider();
  pane.hydrateStoredChatSnapshot(pane.state, sessionKey);
  await chatHistoryRequests(pane.state).initialSnapshotHydration?.promise;
  expect(pane.state.chatMessages).toEqual(transcript.messages);
  expect(provider.hasLoadedSnapshot).toBe(false);
  draw();
  await container.querySelector("openclaw-board-view")?.updateComplete;
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
});

it("persists a board acquired before pane state exists after transcript hydration", async () => {
  const sessionKey = "agent:main:warm-persistence";
  const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
  const response = createDeferred<typeof snapshot>();
  const hydration = createDeferred();
  cleanup.before = () => hydration.resolve();
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
  admitCache(pane, "wss://gateway.example");
  response.resolve(snapshot);
  await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
  expect(
    readChatSessionSnapshot(pane.state.chatMessagesBySession, pane.state, { sessionKey }),
  ).toBeNull();
  cacheChatSessionSnapshot(
    pane.state.chatMessagesBySession,
    pane.state,
    { sessionKey },
    transcript,
  );
  hydration.resolve();
  await hydration.promise;
  await Promise.resolve();
  const cached = readChatSessionSnapshot(pane.state.chatMessagesBySession, pane.state, {
    sessionKey,
  });
  expect(cached?.messages).toEqual(transcript.messages);
  expect(cached?.board?.snapshot).toEqual(snapshot);
});

it("discards a retired lease's deferred cache write after a newer board arrives", async () => {
  const sessionKey = "agent:main:retired-board-cache";
  const { pane, request, snapshot, cleanup } = createGatewayBoardPane(sessionKey);
  const response = createDeferred<BoardSnapshot>();
  const hydration = createDeferred();
  cleanup.before = () => hydration.resolve();
  admitCache(pane, "wss://gateway.example");
  const history = chatHistoryRequests(pane.state);
  history.initialSnapshotHydration = { sessionKey, connected: false, promise: hydration.promise };
  request.mockReturnValueOnce(response.promise);
  const retired = pane.resolveBoardProvider();
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
});

it("shows a board skeleton until the snapshot arrives", async () => {
  const sessionKey = "agent:main:pending-board";
  const { pane, request, snapshot, container, draw } = createGatewayBoardPane(sessionKey);
  const response = createDeferred<BoardSnapshot>();
  request.mockReturnValueOnce(response.promise);
  const provider = pane.resolveBoardProvider();
  draw();
  await waitForSolid(() => expect(container.querySelector("openclaw-board-view")).not.toBeNull());
  const view = container.querySelector("openclaw-board-view")!;
  await view.updateComplete;
  const skeleton = container.querySelector("openclaw-panel-loading-skeleton");
  expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("board");
  expect(skeleton?.getAttribute("role")).toBe("status");
  expect(container.textContent?.trim()).toBe("");
  response.resolve(snapshot);
  await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
  draw();
  await view.updateComplete;
  await view.updateComplete;
  expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
  expect(container.querySelector("openclaw-board-view")).toBe(view);
});

it("replaces the skeleton with a styled alert when the snapshot fails to load", async () => {
  const { pane, request, container, draw } = createGatewayBoardPane("agent:main:failing-board");
  request.mockRejectedValueOnce(new Error("gateway offline"));
  const provider = pane.resolveBoardProvider();
  await vi.waitFor(() => expect(provider.loadError$.value).toBeTruthy());
  draw();
  const alert = container.querySelector('[role="alert"]');
  expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
  expect(alert?.classList.contains("board-session-surface__state--error")).toBe(true);
  expect(alert?.textContent).toContain("gateway offline");
});
