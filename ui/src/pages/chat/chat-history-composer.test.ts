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
  loadChatComposerSnapshot,
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
  const state = Object.assign(
    makeChatHost({
      requestHandlers: { "chat.history": history },
      sessionKey,
    }),
    {
      chatHistoryPagination: { hasMore: false as const },
      handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]): void =>
        handleChatDraftChange(state, next, mentions),
    },
  );
  Object.assign(state.sessions, {
    rewind: vi.fn(() => response),
    refreshReplacement: vi.fn(async () => null),
  });
  vi.spyOn(state.sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => state.sessions.dispose());
  return state;
}

describe("rewind composer ownership", () => {
  it.each(["accepted", "newer draft", "reconnected"] as const)(
    "retires pending attachment reads only for an accepted replacement: %s",
    async (outcome) => {
      const response = createDeferred<{ editorText: string }>();
      const state = createRewindHost(response.promise);
      state.chatMessage = "existing draft";
      const notifications: string[] = [];
      const reads = new ChatAttachmentReadLifecycle(() => notifications.push(state.chatMessage));
      const originalSignal = reads.readSignal;
      reads.updatePending(originalSignal, 1);
      notifications.length = 0;
      const pending = rewindChatHistory(state, "original-user", reads);
      if (outcome === "newer draft") {
        state.handleChatDraftChange("newer draft");
      } else if (outcome === "reconnected") {
        state.connectionEpoch += 1;
      }
      response.resolve({ editorText: "restored prompt" });
      await pending;
      expect(originalSignal.aborted).toBe(outcome === "accepted");
      expect(reads.pendingReads).toBe(outcome === "accepted" ? 0 : 1);
      expect(notifications).toEqual(outcome === "accepted" ? ["restored prompt"] : []);
      if (outcome === "accepted") {
        const replacementSignal = reads.readSignal;
        reads.updatePending(replacementSignal, 1);
        reads.updatePending(originalSignal, -1);
        expect(reads.pendingReads).toBe(1);
        expect(replacementSignal.aborted).toBe(false);
      }
    },
  );

  it("does not cancel replacement-generation reads when an old rewind settles", async () => {
    const response = createDeferred<{ editorText: string }>();
    const state = createRewindHost(response.promise);
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const originalSignal = reads.readSignal;
    reads.updatePending(originalSignal, 1);
    const pending = rewindChatHistory(state, "original-user", reads);

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

  it.each(["same", "different"] as const)(
    "respects a pending attachment admitted by a %s-session peer before bytes arrive",
    async (session) => {
      const response = createDeferred<{ editorText: string }>();
      const source = createRewindHost(response.promise);
      const peer = {
        settings: source.settings,
        sessionKey: session === "same" ? source.sessionKey : "agent:main:session-b",
        chatMessage: "",
        chatQueue: [],
        selectedChatSessionIncognito: false,
      };
      // A stored revision may exceed the local clock before any edit is allocated here.
      persistChatComposerState(source, source.sessionKey, {
        draft: "",
        draftRevision: Date.now() + 60_000,
      });
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      reads.updatePending(signal, 1);
      const pending = rewindChatHistory(source, "original-user", reads);
      markChatComposerEdit(peer);
      response.resolve({ editorText: "restored prompt" });
      await pending;
      expect(source.chatMessage).toBe(session === "same" ? "" : "restored prompt");
      expect(signal.aborted).toBe(session !== "same");
    },
  );

  it.each(["start", "edit"] as const)(
    "restores ordinary message semantics from existing Goal %s mode",
    async (action) => {
      const state = createRewindHost(Promise.resolve({ editorText: "original prompt" }));
      state.chatReplyTarget = { messageId: "unrelated", text: "Old selection" };
      state.chatGoalDraftMode =
        action === "start"
          ? { action }
          : { action, goalId: "goal", previousDraft: "borrowed draft" };

      await rewindChatHistory(state, "original-user", new ChatAttachmentReadLifecycle(() => {}));

      expect(state.chatMessage).toBe("original prompt");
      expect(state.chatGoalDraftMode).toBeNull();
      expect(state.chatReplyTarget).toBeNull();
      expect(loadChatComposerSnapshot(state, state.sessionKey)?.replyTarget).toBeUndefined();
      expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toBeUndefined();
    },
  );

  it.each(
    ["same", "different"].flatMap((session) =>
      [false, true].map((debounced) => ({ session, debounced })),
    ),
  )(
    "respects $session-session peer edits (debounced: $debounced)",
    async ({ session, debounced }) => {
      vi.useFakeTimers();
      const response = createDeferred<{ editorText: string }>();
      const source = createRewindHost(response.promise);
      const peer = {
        settings: source.settings,
        sessionKey: session === "same" ? source.sessionKey : "agent:main:session-b",
        chatMessage: "",
        chatQueue: [],
        selectedChatSessionIncognito: false,
      };
      const persistence = new ChatComposerPersistence(() => peer);
      persistence.start();
      try {
        const pending = rewindChatHistory(
          source,
          "original-user",
          new ChatAttachmentReadLifecycle(() => {}),
        );
        peer.chatMessage = "newer peer draft";
        persistence.schedule();
        if (debounced) {
          await vi.advanceTimersByTimeAsync(200);
        }
        response.resolve({ editorText: "original prompt" });
        await pending;
        persistence.persistNow();

        expect(peer.chatMessage).toBe("newer peer draft");
        expect(loadChatComposerSnapshot(peer, peer.sessionKey)?.draft).toBe("newer peer draft");
        expect(source.chatMessage).toBe(session === "same" ? "" : "original prompt");
      } finally {
        persistence.stop();
      }
    },
  );

  it("lets a later same-session pane own the rewind replacement", async () => {
    const older = createDeferred<{ editorText: string }>();
    const newer = createDeferred<{ editorText: string }>();
    const first = createRewindHost(older.promise);
    const second = createRewindHost(newer.promise);
    const firstPending = rewindChatHistory(
      first,
      "earlier-user",
      new ChatAttachmentReadLifecycle(() => {}),
    );
    const secondPending = rewindChatHistory(
      second,
      "later-user",
      new ChatAttachmentReadLifecycle(() => {}),
    );
    older.resolve({ editorText: "superseded rewind" });
    await firstPending;
    const firstDraft = first.chatMessage;
    newer.resolve({ editorText: "selected rewind" });
    await secondPending;

    expect(firstDraft).toBe("");
    expect(second.chatMessage).toBe("selected rewind");
    expect(loadChatComposerSnapshot(second, second.sessionKey)?.draft).toBe("selected rewind");
  });

  it.each([
    { stage: "rewind", edit: "text" },
    { stage: "rewind", edit: "reply" },
    ...["text", "mentions", "attachments", "goal mode", "reply"].map((edit) => ({
      stage: "history",
      edit,
    })),
  ])("preserves newer composer $edit while awaiting $stage", async ({ stage, edit }) => {
    const response = createDeferred<{ editorText: string }>();
    const history = createDeferred<ChatHistoryResult>();
    const requestedHistory = createDeferred();
    const canonical = { role: "assistant", content: "retained prefix" };
    const state = createRewindHost(response.promise, "main", () => {
      requestedHistory.resolve();
      return stage === "history" ? history.promise : { messages: [canonical] };
    });
    state.chatMessage = edit === "goal mode" ? "" : "@Alex keep this draft";
    state.chatMentions = edit === "goal mode" ? [] : [{ profileId: "alex", start: 0, end: 5 }];
    const pending = rewindChatHistory(
      state,
      "original-user",
      new ChatAttachmentReadLifecycle(() => {}),
    );
    if (stage === "history") {
      response.resolve({ editorText: "original prompt" });
      await requestedHistory.promise;
    }
    if (edit === "text") {
      state.handleChatDraftChange("newer draft", []);
    } else if (edit === "mentions") {
      state.handleChatDraftChange(state.chatMessage, []);
    } else if (edit === "attachments") {
      state.chatAttachments = [
        { id: "new-image", mimeType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
      ];
    } else if (edit === "reply") {
      state.chatReplyTarget = { messageId: "newer", text: "Newer quote" };
    } else {
      state.chatGoalDraftMode = { action: "start" };
    }
    const composer = {
      text: state.chatMessage,
      mentions: state.chatMentions,
      attachments: state.chatAttachments,
      goalMode: state.chatGoalDraftMode,
      replyTarget: state.chatReplyTarget,
    };
    response.resolve({ editorText: "original prompt" });
    history.resolve({ messages: [canonical] });

    await pending;

    expect(state.chatMessages).toEqual([canonical]);
    expect(state.chatMessage).toBe(composer.text);
    expect(state.chatMentions).toEqual(composer.mentions);
    expect(state.chatAttachments).toBe(composer.attachments);
    expect(state.chatGoalDraftMode).toEqual(composer.goalMode);
    expect(state.chatReplyTarget).toEqual(composer.replyTarget);
    expect(state.request).toHaveBeenCalledOnce();
  });

  it("lets only the latest rewind replace the composer", async () => {
    const older = createDeferred<{ editorText: string }>();
    const newer = createDeferred<{ editorText: string }>();
    const state = createRewindHost(older.promise, "main");
    Object.assign(state.sessions, {
      rewind: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise),
    });
    state.chatMessage = "current draft";
    const first = rewindChatHistory(
      state,
      "earlier-user",
      new ChatAttachmentReadLifecycle(() => {}),
    );
    const second = rewindChatHistory(
      state,
      "later-user",
      new ChatAttachmentReadLifecycle(() => {}),
    );
    older.resolve({ editorText: "superseded rewind" });
    await first;
    expect(state.chatMessage).toBe("current draft");
    newer.resolve({ editorText: "selected rewind" });
    await second;
    expect(state.chatMessage).toBe("selected rewind");
  });
});
