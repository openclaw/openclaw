import path from "node:path";
import { expect, it } from "vitest";
import { readNativeForkReplySelection } from "../../auto-reply/reply/commands-fork-reply-selection.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionEntryWithTranscript,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionForkReplySelectionInWorker } from "./session-transcript-read-worker-runtime.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

it("selects only a protected same-conversation user reply in the transcript worker", async () => {
  await withOpenClawTestState({ label: "fork-reply-worker" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "fork-reply-source",
      sessionKey: "agent:main:telegram:fork-reply-source",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "group:source",
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(target, {
      messages: [
        transcriptMessage("foreign", null, {
          role: "user",
          content: "foreign chat",
          __openclaw: {
            transport: { messageId: "reply-1", channel: "telegram", conversationRef: "ref:other" },
          },
        }),
        transcriptMessage("source", "foreign", {
          role: "user",
          content: [{ type: "text", text: "branch here" }],
          __openclaw: {
            transport: { messageId: "reply-1", channel: "telegram", conversationRef: "ref:source" },
          },
        }),
        transcriptMessage("assistant", "source", {
          role: "assistant",
          content: "not a user prompt",
          __openclaw: {
            transport: { messageId: "reply-2", channel: "telegram", conversationRef: "ref:source" },
          },
        }),
        transcriptMessage("older-duplicate", "assistant", {
          role: "user",
          content: "must not select this older entry",
          __openclaw: {
            transport: {
              messageId: "reply-dup",
              channel: "telegram",
              conversationRef: "ref:source",
            },
          },
        }),
        transcriptMessage("newer-empty", "older-duplicate", {
          role: "user",
          content: "",
          __openclaw: {
            transport: {
              messageId: "reply-dup",
              channel: "telegram",
              conversationRef: "ref:source",
            },
          },
        }),
      ],
      touchSessionEntry: false,
    });
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "reply-1",
        conversation,
        replyConversationRef: "ref:source",
      }),
    ).resolves.toEqual({ status: "found", entryId: "source", text: "branch here" });
    await expect(
      readNativeForkReplySelection({
        config: {},
        agentId: "main",
        sessionKey: target.sessionKey,
        replyToId: "reply-1",
        conversation,
        replyConversationRef: "ref:source",
        assertCurrent: () => {},
      }),
    ).resolves.toEqual({ status: "found", entryId: "source", text: "branch here" });
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "reply-1",
        conversation,
        replyConversationRef: "ref:missing",
      }),
    ).resolves.toEqual({ status: "missing" });
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "reply-2",
        conversation,
        replyConversationRef: "ref:source",
      }),
    ).resolves.toEqual({ status: "missing" });
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "reply-dup",
        conversation,
        replyConversationRef: "ref:source",
      }),
    ).resolves.toEqual({ status: "missing" });
  });
});

it("selects an incognito reply through the Gateway's process-held transcript", async () => {
  await withOpenClawTestState({ label: "fork-reply-incognito" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "private-fork-source",
      sessionKey: "agent:main:dashboard:incognito-fork-source",
      storePath: state.statePath("unused-durable.sqlite"),
    };
    await createSessionEntryWithTranscript(target, () => ({
      ok: true,
      entry: { incognito: true, sessionId: target.sessionId, updatedAt: 1 },
    }));
    await persistSessionTranscriptTurn(target, {
      messages: [
        transcriptMessage("private-user", null, {
          role: "user",
          content: "Private branch here",
          __openclaw: {
            transport: {
              messageId: "private-reply",
              channel: "telegram",
              conversationRef: "ref:private",
            },
          },
        }),
      ],
      touchSessionEntry: false,
    });

    await expect(
      readNativeForkReplySelection({
        config: {},
        agentId: "main",
        sessionKey: target.sessionKey,
        replyToId: "private-reply",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "group:private",
        },
        replyConversationRef: "ref:private",
        assertCurrent: () => {},
      }),
    ).resolves.toEqual({ status: "found", entryId: "private-user", text: "Private branch here" });
  });
});
