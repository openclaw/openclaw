import { expectDefined } from "@openclaw/normalization-core";
import { IDBFactory } from "fake-indexeddb";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createInitializationContext,
  createPaneTestHost,
  getPaneTestRuntime,
  createGatewayBrowserClientFixture,
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

  it("holds ready cached rows until connect dispatch and adopts them once", async () => {
    const connect = createDeferred<boolean>();
    const client = createGatewayBrowserClientFixture();
    Object.defineProperty(client, "connectSent", { get: () => connect.promise });
    const pane = createMountedPane("agent:main:connecting", new Map(), client);
    pane.context.gateway.snapshot.phase = "connecting";
    const snapshot = {
      messages: [nativeHistoryMessage(1, "saved transcript")],
      sessionId: "saved-session",
      pagination: { hasMore: false as const },
      deltaCursor: "saved-cursor",
    };
    pane.sessionSnapshotStore = { read: async () => snapshot } as never;
    try {
      const state = startPane(pane);
      const hydration = expectDefined(
        chatHistoryRequests(state).initialSnapshotHydration,
        "pending snapshot hydration",
      );
      await Promise.resolve();
      expect(state.chatMessages).toEqual([]);
      expect(hydration.adoptReadySnapshot).toBeTypeOf("function");
      connect.resolve(true);
      // The subscription reads its cursor synchronously after this adoption.
      hydration.adoptReadySnapshot?.();
      expect(state.chatMessages).toEqual(snapshot.messages);
      expect(hydration.adoptReadySnapshot).toBeUndefined();
      await hydration.promise;
      expect(state.chatMessages).toEqual(snapshot.messages);
    } finally {
      pane.disconnectedCallback();
    }
  });

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
      const snapshot = (pane: TestChatPane) =>
        readChatSessionSnapshot(sharedMessages, pane.state, { sessionKey: targetSessionKey });
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
        const cached = snapshot(first);
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
        await vi.waitFor(() => expect(snapshot(remounted)).not.toBeNull());
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

  it("merges stored history with an admitted prompt when hydration resolves late", async () => {
    const targetSessionKey = "agent:main:first-turn-retry";
    const client = {
      addEventListener: vi.fn(() => vi.fn()),
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    const sharedMessages: ChatMessageCache = new Map();
    const pane = createMountedPane(targetSessionKey, sharedMessages);
    const context = pane.context;
    context.gateway.snapshot.client = client;
    const stored = createDeferred<unknown>();
    pane.sessionSnapshotStore = { read: () => stored.promise } as never;
    const prompt = expect.objectContaining({
      role: "user",
      content: [expect.objectContaining({ type: "text", text: "retry the rejected prompt" })],
    });
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
      expect(attachedState.chatMessages).toEqual([prompt]);
      const storedMessage = nativeHistoryMessage(1, "stored transcript");
      const storedPagination = { hasMore: true as const, nextOffset: 1, totalMessages: 3 };
      const snapshot = {
        deltaCursor: "stored-cursor",
        displayedLeafEntryId: "stored-leaf",
        messages: [storedMessage],
        pagination: storedPagination,
        sessionId: "stored-session",
      };
      stored.resolve(snapshot);
      await Promise.resolve();
      await Promise.resolve();
      expect(attachedState.chatMessages).toEqual([storedMessage, prompt]);
      expect(attachedState).toMatchObject({
        chatDisplayedLeafEntryId: "stored-leaf",
        chatHistoryPagination: storedPagination,
        currentSessionId: "stored-session",
      });
      expect(
        readChatSessionSnapshot(sharedMessages, pane.state, {
          sessionKey: targetSessionKey,
        }),
      ).toEqual({ ...snapshot, messages: attachedState.chatMessages });
    } finally {
      pane.disconnectedCallback();
    }
  });
});
