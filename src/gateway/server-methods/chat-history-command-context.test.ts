import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const directory of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(directory);
      closeOpenClawAgentDatabasesForTest(directory);
    }
    cleanup();
  }),
);

it.each([
  {
    name: "context-free status",
    markers: { excludeFromContext: true, __openclaw: { contextFreeCommand: true } },
    paired: true,
  },
  { name: "ordinary user turn", markers: {}, paired: false },
  { name: "exclusion alone", markers: { excludeFromContext: true }, paired: false },
  {
    name: "command marker alone",
    markers: { __openclaw: { contextFreeCommand: true } },
    paired: false,
  },
  {
    name: "non-boolean exclusion",
    markers: { excludeFromContext: "true", __openclaw: { contextFreeCommand: true } },
    paired: false,
  },
  {
    name: "non-boolean command marker",
    markers: { excludeFromContext: true, __openclaw: { contextFreeCommand: "true" } },
    paired: false,
  },
])("preserves command outcome pairing across $name", async ({ markers, paired }) => {
  const sessionKey = "agent:main:command-context";
  const sessionId = "command-context-session";
  const entry = { sessionId, updatedAt: 42 };
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(tempDirs.make("openclaw-history-command-context-"), "sessions.json"),
  };
  await replaceSessionEntry(scope, entry);
  await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: sessionId }]);
  const head = readTranscriptDisplayDelta(scope);
  if (head.kind !== "page") {
    throw new Error("Expected an initial transcript cursor");
  }
  const cursor = head.cursor;
  const call = {
    role: "assistant",
    __openclaw: { runId: "command-run" },
    content: [
      { type: "toolCall", id: "command", name: "exec", arguments: { command: "printf done" } },
    ],
  };
  const user = { role: "user", content: [{ type: "text", text: "/status" }], ...markers };
  const status = {
    role: "assistant",
    content: [{ type: "text", text: "Status: running." }],
    ...markers,
  };
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
  const saved = readTranscriptDisplayDelta(scope, { cursor });
  const page = await readChatHistoryPage({
    entry,
    provider: "openai",
    sessionId,
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
  const delta = readChatHistoryDelta({
    agentId: "main",
    cursor,
    scope,
    sessionKey,
    sessionSnapshot: buildGatewaySessionSnapshot({
      agentId: "main",
      includeSession: true,
      sessionRow: { key: sessionKey, kind: "direct", ...entry },
    }),
  });
  if (delta.kind !== "delta") {
    throw new Error("Expected the command exchange delta");
  }
  const completed = { toolCallId: "command", phase: "end", status: "completed" };
  for (const activity of [page.activity, delta.activity]) {
    expect(activity).toMatchObject([
      {
        messageId: "command-call",
        items: [
          paired ? completed : { toolCallId: "command", phase: "end", summary: "Outcome unknown" },
        ],
      },
      { messageId: "command-result", items: [completed] },
    ]);
    if (!paired) {
      expect(activity?.[0]?.items[0]).not.toHaveProperty("status");
    }
  }
  for (const messages of [page.messages, delta.messages.map((envelope) => envelope.message)]) {
    expect(messages).toMatchObject(
      [call, user, status, result].map(({ role, content }) => ({ role, content })),
    );
  }
  expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(saved);
});
