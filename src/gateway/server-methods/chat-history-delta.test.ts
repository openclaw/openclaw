import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendSessionTranscriptReport,
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.test-support.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { chatHistoryActivityBytes } from "./chat-history-budget.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

function appendMessage(
  scope: Parameters<typeof appendTranscriptMessage>[0],
  message: Parameters<typeof appendTranscriptMessage>[1]["message"],
  eventId?: string,
) {
  return appendTranscriptMessage(scope, { message, eventId });
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false) {
  return {
    toolCallId,
    toolName,
    isError,
    content: [{ type: "text", text }],
  };
}
function processResult(
  id: string,
  details: Record<string, unknown>,
  isError = false,
  text = "Result",
) {
  return { role: "toolResult", ...toolResult(id, "process", text, isError), details };
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
function processCall(id: string, args: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [toolCall(id, "process", args)],
  };
}

const textMessage = (role: string, text: string) => ({
  role,
  content: [{ type: "text", text }],
});
const mirrorText = "The observatory opens at seven.";
function mirror(sourceAssistantMessageId?: string) {
  return {
    ...textMessage("assistant", mirrorText),
    provider: "openclaw",
    model: "delivery-mirror",
    openclawDeliveryMirror: {
      kind: "channel-final",
      ...(sourceAssistantMessageId ? { sourceAssistantMessageId } : {}),
    },
  };
}
const historyIds = (...ids: string[]) => ids.map((id) => ({ __openclaw: { id } }));
const activity = (messageId: string, ...items: Record<string, unknown>[]) => ({ messageId, items });
const processDetails = (
  status: string,
  aggregated: string,
  exitCode?: number,
  exitReason?: string,
) => ({
  status,
  sessionId: "job",
  aggregated,
  exitCode,
  exitReason,
});
const unknownRead = { toolCallId: "read-1", phase: "end", summary: "Outcome unknown" };
function expectUnknownRead(entries: Awaited<ReturnType<typeof readTail>>["activity"]) {
  expect(entries).toMatchObject([activity("stored-call", unknownRead)]);
  expect(entries?.[0]?.items[0]).not.toHaveProperty("status");
}

const tempDirs = createTempDirTracker();
afterEach(async () => {
  for (const directory of tempDirs.dirs) {
    await closeOpenClawAgentDatabasesAsync(directory);
    closeOpenClawAgentDatabasesForTest(directory);
  }
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
});
const maxBytes = 1_000_000;
const sessionKey = "agent:main:delta-budget";
const sessionId = "delta-budget-session";
const sessionSnapshot = buildGatewaySessionSnapshot({
  agentId: "main",
  includeSession: true,
  sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 42 },
});

async function createTranscript() {
  setRuntimeConfigSnapshot({});
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(
      tempDirs.make("openclaw-delta-budget-"),
      "agents/main/sessions/sessions.json",
    ),
  };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 42 });
  await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: sessionId }]);
  const head = readTranscriptDisplayDelta(scope);
  assert(head.kind === "page", "Expected an initial transcript cursor");
  return { scope, cursor: head.cursor };
}

// Fixed block count keeps serialization overhead stable while every text block
// fits the 8k preview cap. This suite exercises the independent wire-byte budget.
function budgetContent(content: string) {
  const chunkSize = Math.ceil(Math.max(0, content.length - 64) / 127);
  return [
    { type: "text", text: content.slice(0, 64) },
    ...Array.from({ length: 127 }, (_, index) => ({
      type: "text",
      text: content.slice(64 + index * chunkSize, 64 + (index + 1) * chunkSize),
    })),
  ];
}

async function readContents(contents: string[], requestedMaxBytes?: number) {
  const byteLimit = Math.min(requestedMaxBytes ?? maxBytes, maxBytes);
  const { scope, cursor } = await createTranscript();
  for (const [index, content] of contents.entries()) {
    await appendTranscriptMessage(scope, {
      eventId: `result-${index}`,
      now: 42,
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: `call-${index}`,
        content: budgetContent(content),
        providerReplay: { private: "PRIVATE_REPLAY" },
        __openclaw: { upstreamUserText: "PRIVATE_UPSTREAM" },
      },
    });
  }
  const raw = readTranscriptDisplayDelta(scope, {
    cursor,
    maxBytes: byteLimit,
    maxEvents: 200,
  });
  expect(raw).toMatchObject({
    kind: "page",
    hasMore: false,
    events: contents.map((_, index) => ({ messageSeq: index + 1 })),
  });
  assert(raw.kind === "page", "Expected a complete raw delta");
  expect(raw.serializedBytes).toBeLessThan(byteLimit);
  expect(JSON.stringify(raw.events)).toContain("PRIVATE_REPLAY");
  return readChatHistoryDelta({
    agentId: "main",
    cursor,
    maxBytes: requestedMaxBytes,
    scope,
    sessionKey,
    sessionSnapshot: {
      ...sessionSnapshot,
      agentId: undefined,
      label: 'Snapshot: "\\\n漢字🤖\ud800',
    },
  });
}

it("keeps quiet poll results while retaining failures and mutations", async () => {
  const { scope, cursor } = await createTranscript();
  for (const [id, details] of [
    ["poll", processDetails("completed", "private output", 0)],
    ["stopped", processDetails("completed", "stopped", 143, "manual-cancel")],
    ["write", { status: "running", sessionId: "job" }],
    ["failure", processDetails("completed", "output", 2, "exit")],
  ] as const) {
    await appendMessage(scope, processResult(id, details), id);
  }
  const result = await readDelta(scope, cursor);
  expect(result.activity).toMatchObject([
    activity("poll"),
    activity("stopped"),
    activity("write", { name: "process" }),
    activity("failure", { status: "failed" }),
  ]);
  expect(result.messages).toHaveLength(4);
  expect(JSON.stringify(result.messages)).not.toContain("private output");
});

it("projects a poll call and nested result together", async () => {
  const { scope, cursor } = await createTranscript();
  await appendMessage(scope, processCall("poll", { action: "kill" }), "call");
  const nested = {
    type: "toolResult",
    ...toolResult("poll", "process", "Done"),
  };
  await appendMessage(
    scope,
    {
      ...processResult("poll", processDetails("completed", "done")),
      content: [nested],
    },
    "result",
  );
  expect(await readDelta(scope, cursor)).toMatchObject({
    activity: [activity("call"), activity("result")],
  });
});

it.each([false, true])("keeps placeholders until a real result arrives (%s)", async (resolved) => {
  const { scope, cursor } = await createTranscript();
  const missing = { openclawSyntheticMissingToolResult: true, reason: "missing_tool_result" };
  await appendMessage(scope, processCall("poll"), "call");
  await appendMessage(scope, processResult("poll", missing, true, "aborted"), "missing");
  if (resolved) {
    await appendMessage(scope, { role: "assistant", content: [] }, "empty");
    const running = { status: "running", sessionId: "job", aggregated: "working" };
    await appendMessage(scope, processResult("poll", running, false, "working"), "actual");
  }
  const items = resolved ? [] : [{ status: "failed" }];
  expect(await readDelta(scope, cursor)).toMatchObject({
    activity: [
      activity("call", ...items),
      activity("missing", ...items),
      ...(resolved ? [activity("actual")] : []),
    ],
  });
});

it.each([true, false])("preserves reused call IDs (explicit run ownership: %s)", async (scoped) => {
  const { scope, cursor } = await createTranscript();
  for (const [runId, failed] of [
    ["failed-run", true],
    ["quiet-run", false],
  ] as const) {
    const ownership = scoped ? { __openclaw: { runId } } : {};
    const result = processResult(
      "same",
      processDetails(failed ? "failed" : "completed", "output"),
      failed,
    );
    await appendMessage(scope, { ...processCall("same"), ...ownership }, `${runId}-call`);
    await appendMessage(scope, { ...result, ...ownership }, `${runId}-result`);
  }
  const delta = await readDelta(scope, cursor);
  const unknownOutcome = { phase: "end", summary: "Outcome unknown" };
  expect(delta).toMatchObject({
    activity: [
      activity("failed-run-call", scoped ? { status: "failed" } : unknownOutcome),
      activity("failed-run-result", { status: "failed" }),
      activity("quiet-run-call", ...(scoped ? [] : [unknownOutcome])),
      activity("quiet-run-result"),
    ],
  });
  if (!scoped) {
    for (const entry of delta.activity.filter((item) => item.messageId.endsWith("-call"))) {
      expect(entry.items).toHaveLength(1);
      expect(entry.items[0]).not.toHaveProperty("status");
    }
  }
});

it("keeps stored calls unknown until the page includes their result", async () => {
  const { scope, cursor } = await createTranscript();
  const call = {
    role: "assistant",
    content: [toolCall("read-1", "read", { path: "notes.txt" })],
  };
  await appendMessage(scope, call, "stored-call");
  const savedCall = readTranscriptDisplayDelta(scope, { cursor });
  const pending = await readTail(scope);
  const pendingDelta = await readDelta(scope, cursor);
  expect(pending.messages).toMatchObject([call]);
  expect(pendingDelta).toMatchObject({
    messages: [{ messageId: "stored-call", message: call }],
  });
  for (const entries of [pending.activity, pendingDelta.activity]) {
    expectUnknownRead(entries);
  }
  expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(savedCall);

  const result = {
    role: "toolResult",
    ...toolResult("read-1", "read", "Saved notes"),
  };
  await appendMessage(scope, result, "stored-result");
  const savedPair = readTranscriptDisplayDelta(scope, { cursor });
  const olderPage = await readTail(scope, 1, 1);
  expect(olderPage.messages).toMatchObject([call]);
  expectUnknownRead(olderPage.activity);

  const completed = { toolCallId: "read-1", phase: "end", status: "completed" };
  expect(await readDelta(scope, pendingDelta.deltaCursor)).toMatchObject({
    messages: [{ messageId: "stored-result", message: result }],
    activity: [activity("stored-result", completed)],
  });
  const refreshedDelta = await readDelta(scope, cursor);
  for (const refreshed of [await readTail(scope), refreshedDelta]) {
    expect(refreshed.activity).toMatchObject([
      activity("stored-call", completed),
      activity("stored-result", completed),
    ]);
    expect(JSON.stringify(refreshed.activity)).not.toContain("Outcome unknown");
  }
  expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(savedPair);
});

it.each([
  [0, undefined],
  [1, undefined],
  [0, 64 * 1024],
  [1, 64 * 1024],
  [0, 2 * maxBytes],
  [1, 2 * maxBytes],
] as const)(
  "enforces UTF-8 bytes (+%i bytes, maxBytes=%s)",
  async (extraBytes, requestedMaxBytes) => {
    const count = 2;
    const byteLimit = Math.min(requestedMaxBytes ?? maxBytes, maxBytes);
    const prefix = 'escaped: "\\\n🤖\ud800';
    const contents = Array.from({ length: count }, () => prefix);
    const small = await readContents(contents, requestedMaxBytes);
    assert(small.kind === "delta", "Expected the small delta");
    contents[0] =
      prefix +
      "x".repeat(
        byteLimit -
          Buffer.byteLength(JSON.stringify(small.messages), "utf8") -
          chatHistoryActivityBytes(small.activity) +
          extraBytes,
      );
    const result = await readContents(contents, requestedMaxBytes);
    if (extraBytes > 0) {
      expect(result).toEqual({ kind: "reset" });
      return;
    }
    expect(result).toMatchObject({
      kind: "delta",
      activeLeafEntryId: `result-${count - 1}`,
      messages: contents.map((content, index) => ({
        messageId: `result-${index}`,
        messageSeq: index + 1,
        message: { content: budgetContent(content) },
      })),
    });
    assert(result.kind === "delta", "Expected the exact-limit delta");
    const serialized = JSON.stringify(result.messages);
    expect(result.messagesBytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(result.activityBytes).toBe(chatHistoryActivityBytes(result.activity));
    expect(JSON.parse(serialized)[0]).not.toHaveProperty("agentId");
    expect(result.messages[0]).toHaveProperty("label", 'Snapshot: "\\\n漢字🤖\ud800');
    expect(Buffer.byteLength(serialized, "utf8") + chatHistoryActivityBytes(result.activity)).toBe(
      byteLimit,
    );
    expect(serialized).not.toContain("PRIVATE_REPLAY");
    expect(serialized).not.toContain("PRIVATE_UPSTREAM");
  },
);
const assistant = {
  role: "assistant",
  provider: "openai",
  __openclaw: { runId: "run-recovery" },
};
const failedAssistant = {
  ...assistant,
  model: "primary",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
};
const recoveredAssistant = {
  ...assistant,
  ...textMessage("assistant", "Recovered answer"),
  model: "backup",
  stopReason: "stop",
};

type TranscriptScope = Awaited<ReturnType<typeof createTranscript>>["scope"];

function readResponse(scope: TranscriptScope, cursor: string) {
  return readChatHistoryDelta({ agentId: "main", cursor, scope, sessionKey, sessionSnapshot });
}
async function readDelta(scope: TranscriptScope, cursor: string) {
  const result = await readResponse(scope, cursor);
  assert(result.kind === "delta", "Expected an incremental history delta");
  return result;
}

function readTail(scope: TranscriptScope, offset?: number, max = 20) {
  return readChatHistoryPage({
    entry: { sessionId, updatedAt: 42 },
    provider: "openai",
    sessionId,
    storePath: scope.storePath,
    sessionAgentId: "main",
    canonicalKey: sessionKey,
    max,
    maxHistoryBytes: maxBytes,
    effectiveMaxChars: 10_000,
    offset,
    messageId: undefined,
    ignoreCliSessionImports: true,
  });
}

async function reconcile(
  scope: TranscriptScope,
  cursor: string,
  expectedIds: readonly string[],
  rawCursor = cursor,
) {
  const saved = readTranscriptDisplayDelta(scope, { cursor: rawCursor });
  expect(await readResponse(scope, cursor)).toEqual({ kind: "reset" });
  const page = await readTail(scope);
  expect(page.messages).toMatchObject(historyIds(...expectedIds));
  expect(readTranscriptDisplayDelta(scope, { cursor: rawCursor })).toEqual(saved);
  return page;
}

it("delivers committed failure notices once across cursor refresh", async () => {
  const { scope } = await createTranscript();
  await appendMessage(scope, { role: "user", content: "Please help." }, "question");
  const before = await readTail(scope);
  assert(before.deltaCursor, "Expected a cursor before the failure report");
  for (const report of [
    {
      customType: "run-failed-before-reply",
      content: "This turn ended before a reply: The request timed out.",
      display: true,
    },
    { customType: "private-report", content: "PRIVATE_REPORT", display: false },
    { customType: "openclaw.runtime-context", content: "PRIVATE_CONTEXT", display: true },
  ]) {
    await expect(
      appendSessionTranscriptReport(scope, {
        kind: "custom",
        customTypes: [report.customType],
        selectReport: () => ({ ...report, details: { error: "PRIVATE_DIAGNOSTIC" } }),
      }),
    ).resolves.toMatchObject({ ok: true });
  }
  await appendMessage(scope, { role: "user", content: "Please try again." }, "follow-up");

  const delta = await readDelta(scope, before.deltaCursor);
  expect(delta).toMatchObject({
    messages: [
      {
        messageSeq: 2,
        message: {
          role: "custom",
          customType: "run-failed-before-reply",
          content: "This turn ended before a reply: The request timed out.",
          timestamp: expect.any(Number),
          __openclaw: { seq: 2, transcriptPosition: { rawSeq: 2 } },
        },
      },
      { messageId: "follow-up", messageSeq: 3 },
    ],
  });
  const refreshed = await readTail(scope);
  expect(refreshed.pagination?.totalMessages).toBe(3);
  expect(refreshed.messages).toHaveLength(3);
  expect(refreshed.messages.slice(1)).toEqual(delta.messages.map((envelope) => envelope.message));
  expect(JSON.stringify(delta)).not.toContain("PRIVATE_");
  expect(JSON.stringify(refreshed.messages)).not.toContain("PRIVATE_");
  expect(await readDelta(scope, delta.deltaCursor)).toMatchObject({
    messages: [],
    messagesBytes: 2,
    activityBytes: 0,
  });
});
it.each([false, true])("reconciles keyed commentary (tool=%s)", async (withTool) => {
  const { scope, cursor } = await createTranscript();
  const commentary = {
    type: "text",
    text: "First paragraph.\n\n- first file\n- second file",
    textSignature: JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" }),
  };
  const call = toolCall("read-1", "read", { path: "workspace.txt" });
  const savedMessage = {
    role: "assistant",
    content: [commentary, ...(withTool ? [call] : [])],
    stopReason: withTool ? "toolUse" : "stop",
    __openclaw: { runId: "run-commentary" },
  };
  await appendMessage(scope, savedMessage, "commentary-and-tool");

  // A saved cursor must not accept a partial envelope and permanently skip commentary.
  expect(await readResponse(scope, cursor)).toEqual({ kind: "reset" });
  const refreshed = await readTail(scope);
  expect(refreshed.messages).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "text", text: commentary.text }],
      openclawStreamFallback: { source: "segment", itemId: "commentary-1" },
    },
    ...(withTool ? [{ role: "assistant", content: [call] }] : []),
  ]);
  expect(readTranscriptDisplayDelta(scope, { cursor })).toMatchObject({
    kind: "page",
    events: [{ event: { message: savedMessage } }],
  });
  assert(refreshed.deltaCursor, "Reconciled commentary must resume incremental history");
  await appendMessage(scope, textMessage("assistant", "Done."), "final-answer");
  expect(await readDelta(scope, refreshed.deltaCursor)).toMatchObject({
    messages: [{ messageId: "final-answer", message: { content: [{ text: "Done." }] } }],
  });
});
it("enriches reply previews on refresh, then resumes the cursor", async () => {
  const { scope } = await createTranscript();
  const originalText = "original text ".repeat(60);
  await appendMessage(scope, { role: "user", content: originalText }, "original");
  const initial = await readTail(scope);
  assert(initial.deltaCursor, "Expected original transcript cursor");
  for (const message of [
    { role: "user", content: "User reply", __openclaw: { replyToId: "original" } },
    {
      role: "assistant",
      content: "Assistant reply",
      openclawDelivery: { replyToId: "original" },
    },
  ]) {
    await appendTranscriptMessage(scope, { message });
  }
  expect(await readResponse(scope, initial.deltaCursor)).toEqual({ kind: "reset" });
  const page = await readTail(scope, undefined, 2);
  expect(page.messages).toHaveLength(2);
  for (const message of page.messages) {
    expect(message).toHaveProperty("__openclaw.replyToMessage", {
      ok: true,
      message: expect.objectContaining({
        content: `${originalText.slice(0, 500)}\n...(truncated)...`,
        __openclaw: expect.objectContaining({ id: "original", truncated: true }),
      }),
    });
  }
  assert(page.deltaCursor, "Reply page must resume incremental history");
  expect(await readDelta(scope, page.deltaCursor)).toMatchObject({ messages: [] });
});
it.each([true, false])("reconciles mirrors (cursor before answer: %s)", async (beforeAnswer) => {
  const { scope, cursor } = await createTranscript();
  const answer = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Check the opening hours." },
      { type: "text", text: mirrorText },
    ],
  };
  await appendMessage(scope, answer, "answer-1");
  const firstAnswer = await readDelta(scope, cursor);
  await appendMessage(scope, mirror("answer-1"), "mirror-1");
  const refreshed = await reconcile(
    scope,
    beforeAnswer ? cursor : firstAnswer.deltaCursor,
    ["answer-1"],
    cursor,
  );
  assert(refreshed.deltaCursor, "Reconciled mirrors must resume incremental history");

  await appendMessage(scope, answer, "answer-2");
  await appendMessage(scope, mirror("answer-2"), "mirror-2");
  expect(await readResponse(scope, refreshed.deltaCursor)).toEqual({ kind: "reset" });
  const reconciled = await readTail(scope);
  expect(reconciled.messages).toMatchObject(historyIds("answer-1", "answer-2"));
  expect(reconciled.deltaCursor).toEqual(expect.any(String));
});
it.each([
  ["legacy identity", true, false, ["source"]],
  ["fieldless history", false, false, ["source", "mirror"]],
  ["media reply", false, true, ["source", "mirror"]],
] as const)(
  "preserves %s through full reconciliation",
  async (_name, legacyIdentity, media, expectedIds) => {
    const { scope, cursor } = await createTranscript();
    await appendMessage(
      scope,
      {
        role: "assistant",
        content: [
          { type: "text", text: mirrorText },
          ...(media
            ? [{ type: "image", source: { type: "url", url: "https://example.test/chart.png" } }]
            : []),
        ],
        ...(legacyIdentity ? { __openclaw: { mirrorIdentity: "legacy-answer" } } : {}),
      },
      "source",
    );
    await appendMessage(scope, mirror(media ? "source" : undefined), "mirror");
    await reconcile(scope, cursor, expectedIds);
  },
);
it.each([undefined, 0])("keeps recovery refreshes authoritative (offset=%s)", async (offset) => {
  const { scope, cursor } = await createTranscript();
  await appendMessage(scope, failedAssistant, "failed-attempt");
  expect(await readResponse(scope, cursor)).toEqual({ kind: "reset" });

  const pending = await readTail(scope, offset);
  expect(pending.messages).toEqual([]);
  expect(pending).not.toHaveProperty("deltaCursor");

  await appendMessage(scope, recoveredAssistant, "recovered-answer");
  const recovered = await readTail(scope, offset);
  expect(recovered.messages).toMatchObject(historyIds("recovered-answer"));
  expect(recovered.deltaCursor).toEqual(expect.any(String));
  assert(recovered.deltaCursor, "Recovered history must resume incremental updates");

  await appendMessage(scope, { role: "user", content: "next turn" }, "next-user");
  await appendMessage(
    scope,
    { ...recoveredAssistant, __openclaw: { runId: "run-next" } },
    "next-answer",
  );
  expect(await readDelta(scope, recovered.deltaCursor)).toMatchObject({
    deltaCursor: expect.any(String),
    messages: [{ messageId: "next-user" }, { messageId: "next-answer" }],
  });
});
it("merges TTS supplements into visible replies on cursor refresh", async () => {
  const { scope, cursor } = await createTranscript();
  const visibleText = "Plain recon 4101 stays visible.";
  const attachment = {
    type: "attachment",
    attachment: { kind: "audio", label: "reply.wav", mimeType: "audio/wav" },
  };
  await appendMessage(scope, textMessage("assistant", visibleText), "answer");
  const answerDelta = await readDelta(scope, cursor);

  const appended = await appendInjectedAssistantMessageToTranscript({
    ...scope,
    message: "Audio reply",
    content: [{ type: "text", text: "Audio reply" }, attachment],
    ttsSupplement: {
      textSha256: createHash("sha256").update(visibleText).digest("hex"),
    },
  });
  expect(appended.ok).toBe(true);

  expect(await readResponse(scope, answerDelta.deltaCursor)).toEqual({ kind: "reset" });
  const refreshed = await readTail(scope);
  expect(refreshed.messages).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "text", text: visibleText }, attachment],
    },
  ]);
  expect(refreshed.deltaCursor).toEqual(expect.any(String));
});
