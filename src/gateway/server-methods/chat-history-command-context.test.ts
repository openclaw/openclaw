import assert from "node:assert/strict";
import path from "node:path";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.test-support.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";

it.each([
  ["context-free status", true, true, true],
  ["ordinary user turn", undefined, undefined, false],
  ["exclusion alone", true, undefined, false],
  ["command marker alone", undefined, true, false],
  ["non-boolean exclusion", "true", true, false],
  ["non-boolean command marker", true, "true", false],
] as const)("preserves command outcome pairing across %s", (_name, exclusion, command, paired) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const markers = {
      ...(exclusion === undefined ? {} : { excludeFromContext: exclusion }),
      ...(command === undefined ? {} : { __openclaw: { contextFreeCommand: command } }),
    };
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:command-context";
    const entry = { sessionId: "command-context-session", updatedAt: 42 };
    const scope = {
      agentId: "main",
      sessionKey,
      sessionId: entry.sessionId,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: entry.sessionId }]);
    const head = readTranscriptDisplayDelta(scope);
    assert(head.kind === "page", "Expected an initial transcript cursor");
    const call = {
      role: "assistant",
      __openclaw: { runId: "command-run" },
      content: [
        { type: "toolCall", id: "command", name: "exec", arguments: { command: "printf done" } },
      ],
    };
    const text = (role: string, content: string) => ({
      role,
      content: [{ type: "text", text: content }],
      ...markers,
    });
    const user = text("user", "/status");
    const status = text("assistant", "Status: running.");
    const result = {
      role: "toolResult",
      __openclaw: { runId: "command-run" },
      toolCallId: "command",
      toolName: "exec",
      isError: false,
      details: { status: "completed", exitCode: 0, aggregated: "done" },
      content: [{ type: "text", text: "done" }],
    };
    for (const [eventId, message] of [
      ["command-call", call],
      ["status-user", user],
      ["status-reply", status],
      ["command-result", result],
    ] as const) {
      await appendTranscriptMessage(scope, { eventId, message });
    }
    const saved = readTranscriptDisplayDelta(scope, { cursor: head.cursor });
    const page = await readChatHistoryPage({
      entry,
      provider: "openai",
      sessionId: entry.sessionId,
      storePath: scope.storePath,
      sessionAgentId: "main",
      canonicalKey: sessionKey,
      max: 20,
      maxHistoryBytes: 1_000_000,
      effectiveMaxChars: 10_000,
      offset: undefined,
      messageId: undefined,
      ignoreCliSessionImports: true,
    });
    const delta = await readChatHistoryDelta({
      agentId: "main",
      cursor: head.cursor,
      scope,
      sessionKey,
      sessionSnapshot: {},
    });
    assert(delta.kind === "delta", "Expected the command exchange delta");
    const completed = { toolCallId: "command", phase: "end", status: "completed" };
    const outcome = paired
      ? completed
      : { toolCallId: "command", phase: "end", unpairedCall: true };
    for (const activity of [page.activity, delta.activity]) {
      expect(activity).toMatchObject([
        { messageId: "command-call", items: [outcome] },
        { messageId: "command-result", items: [completed] },
      ]);
      if (!paired) {
        expect(activity?.[0]?.items[0]).not.toHaveProperty("status");
        expect(activity?.[0]?.items[0]).not.toHaveProperty("summary");
      }
    }
    for (const messages of [page.messages, delta.messages.map((envelope) => envelope.message)]) {
      expect(messages).toMatchObject(
        [call, user, status, result].map(({ role, content }) => ({ role, content })),
      );
    }
    expect(readTranscriptDisplayDelta(scope, { cursor: head.cursor })).toEqual(saved);
  }),
);
