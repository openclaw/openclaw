// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { rewindChatHistory } from "./chat-history-actions.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import {
  ChatComposerPersistence,
  loadChatComposerState,
  markChatComposerEdit,
  persistChatComposerState,
} from "./composer-persistence.ts";
import { handleChatDraftChange } from "./input-history.ts";

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createRewindHost(
  response: Promise<{ editorText: string }>,
  sessionKey = "agent:main:session-a",
  history: () => ChatHistoryResult | Promise<ChatHistoryResult> = () => ({ messages: [] }),
) {
  const state = makeChatHost({
    requestHandlers: { "chat.history": history },
    sessionKey,
    chatHistoryPagination: { hasMore: false },
  });
  Object.assign(state.sessions, {
    rewind: vi.fn(() => response),
    refreshReplacement: vi.fn(async () => null),
  });
  vi.spyOn(state.sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => state.sessions.dispose());
  return Object.assign(state, {
    handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]) =>
      handleChatDraftChange(state, next, mentions),
  });
}
function pendingRewind() {
  const response = createDeferred<{ editorText: string }>();
  return { response, state: createRewindHost(response.promise) };
}

const rewind = (
  state: ReturnType<typeof createRewindHost>,
  entryId = "original-user",
  reads = new ChatAttachmentReadLifecycle(() => {}),
) => rewindChatHistory(state, entryId, reads);
function createPeer(source: ReturnType<typeof createRewindHost>, session: string) {
  return {
    client: source.client,
    settings: source.settings,
    sessionKey: session === "same" ? source.sessionKey : "agent:main:session-b",
    chatMessage: "",
    chatQueue: [],
    selectedChatSessionIncognito: false,
  };
}

describe("rewind composer ownership", () => {
  it.each(["accepted", "newer draft"] as const)(
    "retires pending attachment reads only for an accepted replacement: %s",
    async (outcome) => {
      const { response, state } = pendingRewind();
      state.chatMessage = "existing draft";
      state.chatReplyTarget = { messageId: "unrelated", text: "Old selection" };
      state.chatGoalDraftMode = { action: "start" };
      const notifications: string[] = [];
      const reads = new ChatAttachmentReadLifecycle(() => notifications.push(state.chatMessage));
      const originalSignal = reads.readSignal;
      reads.updatePending(originalSignal, 1);
      notifications.length = 0;
      const pending = rewind(state, "original-user", reads);
      if (outcome === "newer draft") {
        state.handleChatDraftChange("newer draft");
      }
      response.resolve({ editorText: "restored prompt" });
      await pending;
      expect(originalSignal.aborted).toBe(outcome === "accepted");
      expect(reads.pendingReads).toBe(outcome === "accepted" ? 0 : 1);
      expect(notifications).toEqual(outcome === "accepted" ? ["restored prompt"] : []);
      if (outcome === "accepted") {
        expect(state).toMatchObject({ chatGoalDraftMode: null, chatReplyTarget: null });
        const snapshot = loadChatComposerState(state, state.sessionKey).snapshot;
        expect(snapshot?.replyTarget).toBeUndefined();
        expect(snapshot?.goalMode).toBeUndefined();
        const replacementSignal = reads.readSignal;
        reads.updatePending(replacementSignal, 1);
        reads.updatePending(originalSignal, -1);
        expect(reads.pendingReads).toBe(1);
        expect(replacementSignal.aborted).toBe(false);
      }
    },
  );

  it("does not cancel replacement-generation reads when an old rewind settles", async () => {
    const { response, state } = pendingRewind();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const originalSignal = reads.readSignal;
    reads.updatePending(originalSignal, 1);
    const pending = rewind(state, "original-user", reads);

    reads.abortReads();
    const replacementSignal = reads.readSignal;
    reads.updatePending(replacementSignal, 1);
    response.resolve({ editorText: "restored source prompt" });
    await pending;

    expect(state.chatMessage).toBe("restored source prompt");
    expect(originalSignal.aborted).toBe(true);
    expect(replacementSignal.aborted).toBe(false);
    expect(reads.pendingReads).toBe(1);
  });

  it.each([
    { session: "same", edit: "pending" },
    { session: "different", edit: "pending" },
    { session: "same", edit: "immediate" },
    { session: "different", edit: "debounced" },
  ])("respects $session-session peer $edit edits during rewind", async ({ session, edit }) => {
    vi.useFakeTimers();
    const { response, state: source } = pendingRewind();
    const peer = createPeer(source, session);
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const signal = reads.readSignal;
    const persistence = edit === "pending" ? undefined : new ChatComposerPersistence(() => peer);
    persistence?.start();
    try {
      if (!persistence) {
        // The persisted revision can exceed this pane's edit clock before bytes arrive.
        persistChatComposerState(source, source.sessionKey, {
          draft: "",
          draftRevision: Date.now() + 60_000,
        });
        reads.updatePending(signal, 1);
      }
      const pending = rewind(source, "original-user", reads);
      if (persistence) {
        peer.chatMessage = "newer peer draft";
        persistence.schedule();
      } else {
        markChatComposerEdit(peer);
      }
      if (edit === "debounced") {
        await vi.advanceTimersByTimeAsync(200);
      }
      response.resolve({ editorText: "restored prompt" });
      await pending;
      persistence?.persistNow();
      expect(source.chatMessage).toBe(session === "same" ? "" : "restored prompt");
      if (persistence) {
        expect(peer.chatMessage).toBe("newer peer draft");
        expect(loadChatComposerState(peer, peer.sessionKey).snapshot?.draft).toBe(
          "newer peer draft",
        );
      } else {
        expect(signal.aborted).toBe(session !== "same");
      }
    } finally {
      persistence?.stop();
    }
  });

  it.each([{ edit: "attachments" }, { edit: "reply" }])(
    "preserves newer composer $edit while awaiting history",
    async ({ edit }) => {
      const response = createDeferred<{ editorText: string }>();
      const history = createDeferred<ChatHistoryResult>();
      const requestedHistory = createDeferred();
      const canonical = { role: "assistant", content: "retained prefix" };
      const state = createRewindHost(response.promise, "main", () => {
        requestedHistory.resolve();
        return history.promise;
      });
      state.chatMessage = "@Alex keep this draft";
      state.chatMentions = [{ profileId: "alex", start: 0, end: 5 }];
      const pending = rewind(state);
      response.resolve({ editorText: "original prompt" });
      await requestedHistory.promise;
      if (edit === "attachments") {
        state.chatAttachments = [
          { id: "new-image", mimeType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
        ];
      } else {
        state.chatReplyTarget = { messageId: "newer", text: "Newer quote" };
      }
      const { chatMessage, chatMentions, chatAttachments, chatGoalDraftMode, chatReplyTarget } =
        state;
      history.resolve({ messages: [canonical] });

      await pending;

      expect(state.chatMessages).toEqual([canonical]);
      expect(state).toMatchObject({
        chatMessage,
        chatMentions,
        chatGoalDraftMode,
        chatReplyTarget,
      });
      expect(state.chatAttachments).toBe(chatAttachments);
      expect(state.request).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "lets only the latest rewind own replacement (peer pane=%s)",
    async (peerPane) => {
      const { response: older, state: first } = pendingRewind();
      const newer = createDeferred<{ editorText: string }>();
      const second = peerPane ? createRewindHost(newer.promise) : first;
      if (!peerPane) {
        Object.assign(first.sessions, {
          rewind: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise),
        });
        first.chatMessage = "current draft";
      }
      const firstPending = rewind(first, "earlier-user");
      const secondPending = rewind(second, "later-user");
      older.resolve({ editorText: "superseded rewind" });
      await firstPending;
      expect(first.chatMessage).toBe(peerPane ? "" : "current draft");
      newer.resolve({ editorText: "selected rewind" });
      await secondPending;
      expect(second.chatMessage).toBe("selected rewind");
      expect(loadChatComposerState(second, second.sessionKey).snapshot?.draft).toBe(
        "selected rewind",
      );
    },
  );
});
