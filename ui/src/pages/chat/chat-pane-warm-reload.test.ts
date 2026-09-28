/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { IDBFactory } from "fake-indexeddb";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { loadChatHistory, resumePendingChatHistoryLoad } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.ts";

describe("chat pane warm reload", () => {
  afterEach(resetTranscriptTestDom);

  it.each([
    { name: "current nonempty", legacy: false, empty: false, networkEmpty: false },
    { name: "current empty", legacy: false, empty: true, networkEmpty: true },
    { name: "legacy nonempty", legacy: true, empty: false, networkEmpty: false },
    { name: "legacy empty", legacy: true, empty: true, networkEmpty: false },
    {
      name: "legacy empty with an empty Gateway transcript",
      legacy: true,
      empty: true,
      networkEmpty: true,
    },
  ])(
    "restores $name history and resumes with an adopted cursor",
    async ({ legacy, empty, networkEmpty }) => {
      installTranscriptDomMocks();
      vi.stubGlobal("indexedDB", new IDBFactory());
      const sessionKey = "agent:main:warm-reload";
      const remembered = nativeHistoryMessage(1, "The browser remembers this conversation.");
      const messages = empty ? [] : [remembered];
      const currentMessages = networkEmpty
        ? []
        : [remembered, nativeHistoryMessage(2, "A newer turn is present on the Gateway.")];
      const writer = new SessionSnapshotStore();
      const snapshot = {
        deltaCursor: "warm-reload-cursor",
        messages,
        pagination: { hasMore: false, completeSnapshot: true } as const,
        sessionId: "warm-reload-session",
      };
      writer.write(sessionKey, snapshot);
      await writer.flush();
      if (legacy) {
        const database = await openSessionSnapshotDatabase();
        if (!database) {
          throw new Error("Expected snapshot database");
        }
        const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
        const completed = transactionComplete(transaction);
        transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({
          savedAt: Date.now(),
          sessionId: snapshot.sessionId,
          sessionKey,
          snapshot,
        });
        await completed;
        database.close();
      }

      const memory: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(memory);
      observeChatCache(memory, store);
      const read = vi.spyOn(store, "read");
      const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
      vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
      vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
      const context = createInitializationContext();
      context.gateway.snapshot.phase = "connecting";
      pane.context = { ...context, sessions: createTestSessionCapability(context.gateway) };
      pane.sessionKey = sessionKey;
      pane.chatMessagesBySession = memory;
      pane.sessionSnapshotStore = store;
      const attached = new Error("pane state attached");
      vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
        throw attached;
      });
      const sessionInfo = {
        key: sessionKey,
        kind: "direct",
        sessionId: "warm-reload-session",
        updatedAt: 1,
      };
      const request = createGatewayRequestMock(async (_method, params) =>
        asOptionalRecord(params)?.cursor
          ? { kind: "delta", messages: [], deltaCursor: "warm-reload-next-cursor", sessionInfo }
          : {
              messages: currentMessages,
              sessionId: snapshot.sessionId,
              hasMore: false,
              deltaCursor: "warm-reload-next-cursor",
              sessionInfo,
            },
      );
      const client = createGatewayBrowserClientFixture({ request });
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));

      try {
        expect(() => pane.connectedCallback()).toThrow(attached);
        await loadChatHistory(pane.state, { startup: true });
        await read.mock.results[0]?.value;
        expect(pane.state.chatMessages).toEqual(messages);
        expect(pane.state.connected).toBe(false);
        expect(request).not.toHaveBeenCalled();
        render(
          renderChatThread(
            threadProps("warm-reload-pane", sessionKey, pane.state.chatMessages),
            transcript,
          ),
          container,
        );
        transcript.hostConnected();
        transcript.hostUpdated();
        if (!empty) {
          expect(container.textContent).toContain("The browser remembers this conversation.");
        }
        await store.flush();
        const rewritten = legacy ? await new SessionSnapshotStore().read(sessionKey) : null;

        pane.state.client = client;
        pane.state.connected = true;
        pane.state.connectionEpoch = 1;
        await resumePendingChatHistoryLoad(pane.state);

        expect(pane.state.chatMessages).toEqual(legacy ? currentMessages : messages);
        render(
          renderChatThread(
            threadProps("warm-reload-pane", sessionKey, pane.state.chatMessages),
            transcript,
          ),
          container,
        );
        transcript.hostUpdated();
        if (legacy && !networkEmpty) {
          expect(container.textContent).toContain("A newer turn is present on the Gateway.");
        }
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "chat.startup",
          legacy
            ? expect.not.objectContaining({ cursor: expect.anything() })
            : expect.objectContaining({ sessionKey, cursor: "warm-reload-cursor" }),
          { signal: expect.any(AbortSignal) },
        );
        if (legacy) {
          expect(rewritten).toEqual({
            messages,
            pagination: snapshot.pagination,
            sessionId: snapshot.sessionId,
          });
        }
        await loadChatHistory(pane.state, { startup: true, deferBranches: true });
        expect(request).toHaveBeenLastCalledWith(
          "chat.startup",
          expect.objectContaining({ sessionKey, cursor: "warm-reload-next-cursor" }),
          { signal: expect.any(AbortSignal) },
        );
        expect(pane.state.chatMessages).toEqual(legacy ? currentMessages : messages);
      } finally {
        render(null, container);
        transcript.hostDisconnected();
        pane.disconnectedCallback();
        pane.context.sessions.dispose();
        await store.flush();
        await clearStoredChatSnapshots();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );
});
