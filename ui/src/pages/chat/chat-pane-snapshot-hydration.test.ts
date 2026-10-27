import { expectDefined } from "@openclaw/normalization-core";
import { IDBFactory } from "fake-indexeddb";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createInitializationContext,
  createGatewayBrowserClientFixture,
} from "./chat-application-context.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createPaneTestHost,
  getPaneTestRuntime,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { releaseChatMediaResourceOwner } from "./components/chat-message-media.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import {
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";
import "./chat-pane.tsx";

const transcriptOnlyHello = gatewayHelloForMethods(["chat.history"]);

describe("stored chat snapshot hydration", () => {
  afterEach(resetTranscriptTestDom);

  function createMountedPane(
    targetSessionKey: string,
    sharedMessages: ChatMessageCache,
    client?: GatewayBrowserClient,
  ) {
    // SAFETY: The fixture uses the real pane runtime and its forwarded test surface.
    const pane = createPaneTestHost(
      "openclaw-chat-runtime-test",
      ChatPaneRuntime,
    ) as unknown as TestChatPane;
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = sharedMessages;
    pane.context = createInitializationContext(
      client ??
        createGatewayBrowserClientFixture({
          offlineRecoveryScope: "test-recovery-scope",
          recoveryScopeReady: false,
        }),
    );
    pane.context.gateway.snapshot.hello = transcriptOnlyHello;
    vi.spyOn(pane.context.sessions, "listBranches").mockResolvedValue([]);
    return pane;
  }

  function startPane(pane: TestChatPane, attach?: (state: ChatPageHost) => void) {
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      attach?.(state);
      throw stopAfterAttach;
    });
    expect(() => getPaneTestRuntime(pane).start()).toThrow(stopAfterAttach);
    return expectDefined(attachedState, "attached pane state");
  }

  function networkHydration(sessionKey: string, client: GatewayBrowserClient) {
    const memory: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memory);
    store.connect();
    observeChatCache(memory, store);
    const pane = createMountedPane(sessionKey, memory, client);
    pane.sessionSnapshotStore = store;
    return {
      pane,
      start: () =>
        startPane(pane, (state) => {
          Object.assign(state, { client, connected: true, connectionEpoch: 1 });
          void loadChatHistory(state);
        }),
      dispose: async () => {
        pane.disconnectedCallback();
        store.disconnect();
        await store.whenIdle();
        await clearStoredChatSnapshots();
      },
    };
  }

  async function writeStoredSnapshot(
    targetSessionKey: string,
    messages: ReturnType<typeof nativeHistoryMessage>[],
  ) {
    const writer = new SessionSnapshotStore();
    writer.write(
      resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey: targetSessionKey },
      ),
      {
        messages,
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "persistent-session",
      },
    );
    await writer.flush();
  }

  it("displays a prepared cached page while the socket cannot open", async () => {
    const client = createGatewayBrowserClientFixture();
    Object.defineProperty(client, "connectSent", { get: () => new Promise(() => {}) });
    const pane = createMountedPane("agent:main:offline-boot", new Map(), client);
    pane.context.gateway.snapshot.phase = "connecting";
    const snapshot = {
      messages: [nativeHistoryMessage(1, "Saved page before socket open")],
      sessionId: "saved-session",
      pagination: { hasMore: false as const },
    };
    const read = createDeferred<typeof snapshot>();
    pane.sessionSnapshotStore = { readReady: () => undefined, read: () => read.promise } as never;
    try {
      const state = startPane(pane);
      read.resolve(snapshot);
      await read.promise;
      await Promise.resolve();
      expect(state.chatMessages).toEqual(snapshot.messages);
      expect(state.connected).toBe(false);
    } finally {
      pane.disconnectedCallback();
    }
  });

  it.each(["connecting", "connected"] as const)(
    "adopts stored history without waiting for connection or paint (%s)",
    async (phase) => {
      const pane = createMountedPane("agent:main:first-paint", new Map());
      pane.context.gateway.snapshot.phase = phase;
      const snapshot = {
        messages: [nativeHistoryMessage(1, "cached first paint")],
        sessionId: "saved-session",
        pagination: { hasMore: false as const },
      };
      const store = new SessionSnapshotStore();
      vi.spyOn(store, "read").mockResolvedValue(snapshot);
      pane.sessionSnapshotStore = store;
      try {
        const state = startPane(pane);
        await chatHistoryRequests(state).initialSnapshotHydration?.promise;
        expect(state.chatMessages).toEqual(snapshot.messages);
      } finally {
        pane.disconnectedCallback();
        store.disconnect();
      }
    },
  );

  it.each(
    ["memory", "stored"].flatMap((cacheMode) =>
      ["Gateway Author", undefined].map((senderName) => ({ cacheMode, senderName })),
    ),
  )(
    "keeps one attributed initial source through $cacheMode remount, custody, and promotion ($senderName)",
    async ({ cacheMode, senderName }) => {
      installTranscriptDomMocks();
      vi.stubGlobal("indexedDB", new IDBFactory());
      const mediaResponse = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => mediaResponse.promise),
      );
      const targetSessionKey = "agent:main:cached-initial";
      const runId = "cached-initial-send";
      const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
      const request = vi.fn().mockResolvedValue({
        messages: [],
        sessionId: "cached-initial-session",
        sessionInfo: {
          key: targetSessionKey,
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          status: "running",
        },
      } satisfies ChatHistoryResult);
      const client = createGatewayBrowserClientFixture({ request });
      const context = createInitializationContext(client);
      context.gateway.snapshot.hello = transcriptOnlyHello;
      vi.spyOn(context.sessions, "listBranches").mockResolvedValue([]);
      context.chatSubmissions.retain(
        buildInitialChatSubmission(
          targetSessionKey,
          {
            text: "Keep the attributed initial image",
            createdAt: 1,
            sender: { id: "local-author", name: "Local Author" },
            attachments: [{ id: "cached-image", mimeType: "image/png", dataUrl }],
          },
          client,
          runId,
        ),
      );
      const sharedMessages: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(sharedMessages);
      observeChatCache(sharedMessages, store);
      const mount = (stored = false) => {
        const pane = createMountedPane(targetSessionKey, sharedMessages);
        pane.context = context;
        if (stored) {
          pane.sessionSnapshotStore = store;
        }
        startPane(pane, (state) => Object.assign(state, { client, connected: true }));
        return pane;
      };
      const first = mount();
      try {
        // A stale network response commits the still-visible local prompt to cache.
        await loadChatHistory(first.state);
        const cached = readChatSessionSnapshot(sharedMessages, first.state, {
          sessionKey: targetSessionKey,
        });
        expect(cached?.messages).toEqual(first.state.chatMessages);
        expect(cached?.messages).toHaveLength(1);
        expect(cached?.messages[0]).toMatchObject({ __openclaw: { senderId: "local-author" } });
      } finally {
        first.disconnectedCallback();
      }
      await store.flush();
      if (cacheMode === "stored") {
        sharedMessages.clear();
      }
      const remounted = mount(cacheMode === "stored");
      const transcript = createTestTranscript();
      let view: ReturnType<typeof mountChatThread> | undefined;
      const renderPane = (): ReturnType<typeof mountChatThread> => {
        const props = {
          ...threadProps("cached-initial-pane", targetSessionKey, remounted.state.chatMessages),
          pendingInputs: getChatPendingInputs(remounted.state)?.page.items,
          assistantAttachmentAuthToken: "test-auth-token",
          connectionEpoch: 1,
          mediaOwner: renderPane,
        };
        if (view) {
          view.update(props);
        } else {
          view = mountChatThread(props, transcript);
        }
        transcript.update();
        return view;
      };
      try {
        await vi.waitFor(() =>
          expect(
            readChatSessionSnapshot(sharedMessages, remounted.state, {
              sessionKey: targetSessionKey,
            }),
          ).not.toBeNull(),
        );
        const { container } = renderPane();
        transcript.start();
        flush();
        await vi.dynamicImportSettled();
        const displayed = await waitForSolid(() =>
          expectDefined(
            container.querySelector<HTMLImageElement>(".chat-message-image"),
            "remounted initial image",
          ),
        );
        // jsdom has no decoder; deliver the loaded-preview boundary before custody.
        Object.defineProperty(displayed, "naturalWidth", { value: 1 });
        displayed.dispatchEvent(new Event("load"));
        const expectRenderedInput = (text: string, author: string | undefined) => {
          expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
          expect(container.querySelectorAll(".chat-message-image")).toHaveLength(1);
          expect(container.querySelector(".chat-message-image")).toBe(displayed);
          expect(displayed.getAttribute("src")).toBe(dataUrl);
          expect(container.querySelector('[aria-busy="true"]')).toBeNull();
          expect(container.textContent).toContain(text);
          const sender = container.querySelector(".chat-sender-name");
          expect(sender?.textContent?.trim()).toBe(author ?? "Message");
        };
        expectRenderedInput("Keep the attributed initial image", "Local Author");
        const metadata = {
          id: "pending:cached-input",
          ...(senderName ? { senderName } : {}),
          media: [{ url: "media://inbound/cached-image", contentType: "image/png" }],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        };
        const custodyMessage = {
          role: "user",
          content: "Gateway accepted the initial image",
          __openclaw: metadata,
        };
        applyChatPendingInputs(remounted.state, {
          total: 1,
          items: [
            { id: "cached-input", runId, acceptedAt: 1, state: "queued", message: custodyMessage },
          ],
        });
        renderPane();
        expect(remounted.state.chatMessages).toEqual([]);
        expect(
          getChatPendingInputs(remounted.state)?.page.items.map((item) => item.message),
        ).toEqual([custodyMessage]);
        expectRenderedInput(custodyMessage.content, senderName);
        expect(container.textContent).not.toContain("Keep the attributed initial image");
        expect(custodyMessage["__openclaw"]).toBe(metadata);
        const canonicalMessage = {
          ...custodyMessage,
          content: "Gateway persisted the initial image",
          __openclaw: {
            ...metadata,
            id: "cached-input",
            seq: 1,
            idempotencyKey: `${runId}:user`,
            runId: "execution-run",
          },
        };
        request.mockResolvedValue({
          sessionId: "cached-initial-session",
          messages: [canonicalMessage],
          pendingInputs: { items: [], total: 0 },
        });
        await loadChatHistory(remounted.state);
        renderPane();
        expect(remounted.state.chatMessages).toEqual([canonicalMessage]);
        expectRenderedInput(canonicalMessage.content, senderName);
        expect(container.textContent).not.toContain(custodyMessage.content);
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
      } finally {
        view?.unmount();
        releaseChatMediaResourceOwner(renderPane);
        transcript.dispose();
        remounted.disconnectedCallback();
        await store.flush();
        await clearStoredChatSnapshots();
      }
    },
  );

  it.each(["delayed", "immediate"] as const)(
    "hydrates persistent history without overwriting its %s network refresh",
    async (timing) => {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const targetSessionKey = "agent:main:persistent";
      const cachedMessages = [nativeHistoryMessage(1, "persistent history")];
      const networkMessages = [nativeHistoryMessage(1, "network history")];
      await writeStoredSnapshot(targetSessionKey, cachedMessages);
      const response = createDeferred<Record<string, unknown>>();
      const request = vi.fn(() => response.promise);
      const hydration = networkHydration(
        targetSessionKey,
        timing === "delayed"
          ? createGatewayBrowserClientFixture({ request })
          : ({ request } as unknown as GatewayBrowserClient),
      );
      if (timing === "immediate") {
        response.resolve({ messages: networkMessages, sessionId: "network-session" });
      }
      try {
        const state = hydration.start();
        if (timing === "delayed") {
          await vi.waitFor(() => expect(state.chatMessages).toEqual(cachedMessages));
          expect(request).toHaveBeenCalledWith(
            "chat.history",
            expect.objectContaining({ sessionKey: targetSessionKey }),
            { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
          );
          response.resolve({ messages: networkMessages, sessionId: "network-session" });
        }
        await vi.waitFor(() => expect(state.chatMessages).toEqual(networkMessages));
        if (timing === "immediate") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          expect(state.chatMessages).toEqual(networkMessages);
        }
      } finally {
        await hydration.dispose();
      }
    },
  );

  it("merges stored history with an admitted prompt when hydration resolves late", async () => {
    vi.useFakeTimers();
    const targetSessionKey = "agent:main:first-turn-retry";
    const client = {
      addEventListener: vi.fn(() => vi.fn()),
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    const sharedMessages: ChatMessageCache = new Map();
    const pane = createMountedPane(targetSessionKey, sharedMessages);
    const context = pane.context;
    context.gateway.snapshot.client = client;
    let deliverStoredSnapshot: ((snapshot: unknown) => void) | undefined;
    pane.sessionSnapshotStore = {
      readReady: () => undefined,
      read: () =>
        new Promise((resolve) => {
          deliverStoredSnapshot = resolve;
        }),
    } as never;
    context.chatSubmissions.retain(
      buildInitialChatSubmission(
        targetSessionKey,
        { attachments: [], createdAt: 1, text: "retry the rejected prompt" },
        client,
        "initial-run",
      ),
    );
    try {
      const attachedState = startPane(pane);
      expect(attachedState?.chatMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: "retry the rejected prompt" })],
        }),
      ]);
      const storedMessage = nativeHistoryMessage(1, "stored transcript");
      const storedPagination = { hasMore: true as const, nextOffset: 1, totalMessages: 3 };
      deliverStoredSnapshot?.({
        deltaCursor: "stored-cursor",
        displayedLeafEntryId: "stored-leaf",
        messages: [storedMessage],
        pagination: storedPagination,
        sessionId: "stored-session",
      });
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersToNextFrame();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliverStoredSnapshot).toBeDefined();
      expect(attachedState?.chatMessages).toEqual([
        storedMessage,
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: "retry the rejected prompt" })],
        }),
      ]);
      expect(attachedState).toMatchObject({
        chatDisplayedLeafEntryId: "stored-leaf",
        chatHistoryPagination: storedPagination,
        currentSessionId: "stored-session",
      });
      expect(
        readChatSessionSnapshot(sharedMessages, pane.state, {
          sessionKey: targetSessionKey,
        }),
      ).toEqual({
        deltaCursor: "stored-cursor",
        displayedLeafEntryId: "stored-leaf",
        messages: attachedState?.chatMessages,
        pagination: storedPagination,
        sessionId: "stored-session",
      });
    } finally {
      pane.disconnectedCallback();
      vi.useRealTimers();
    }
  });
});
