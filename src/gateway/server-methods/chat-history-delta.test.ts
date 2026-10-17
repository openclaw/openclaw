import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function processResult(toolCallId: string, details: Record<string, unknown>, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "process",
    isError,
    details,
    content: [{ type: "text", text: "Result" }],
  };
}

function processCall(id: string, args: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "process", arguments: args }],
  };
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
      "agents",
      "main",
      "sessions",
      "sessions.json",
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

describe("chat history delta display budget", () => {
  it("keeps a result-only poll delta quiet without dropping failed or mutating results", async () => {
    const { scope, cursor } = await createTranscript();
    for (const [id, details] of [
      [
        "poll",
        { status: "completed", sessionId: "job", aggregated: "private output", exitCode: 0 },
      ],
      [
        "stopped",
        {
          status: "completed",
          sessionId: "job",
          aggregated: "stopped",
          exitCode: 143,
          exitReason: "manual-cancel",
        },
      ],
      ["write", { status: "running", sessionId: "job" }],
      [
        "failure",
        {
          status: "completed",
          sessionId: "job",
          aggregated: "output",
          exitCode: 2,
          exitReason: "exit",
        },
      ],
    ] as const) {
      await appendMessage(scope, processResult(id, details), id);
    }
    const result = await readDelta(scope, cursor);
    assert(result.kind === "delta", "Expected a result delta");
    expect(result.activity).toMatchObject([
      { messageId: "poll", items: [] },
      { messageId: "stopped", items: [] },
      { messageId: "write", items: [{ name: "process" }] },
      { messageId: "failure", items: [{ status: "failed" }] },
    ]);
    expect(result.messages).toHaveLength(4);
    expect(JSON.stringify(result.messages)).not.toContain("private output");
  });

  it("projects a poll call and its result together before producing a delta", async () => {
    const { scope, cursor } = await createTranscript();
    await appendMessage(scope, processCall("poll", { action: "kill" }), "call");
    await appendMessage(
      scope,
      {
        role: "toolResult",
        toolCallId: "poll",
        toolName: "process",
        isError: false,
        details: { status: "completed", sessionId: "job", aggregated: "done" },
        content: [
          {
            type: "toolResult",
            toolCallId: "poll",
            toolName: "process",
            content: [{ type: "text", text: "Done" }],
            isError: false,
          },
        ],
      },
      "result",
    );
    expect(await readDelta(scope, cursor)).toMatchObject({
      kind: "delta",
      activity: [
        { messageId: "call", items: [] },
        { messageId: "result", items: [] },
      ],
    });
  });

  it.each([false, true])(
    "keeps missing-result placeholders visible until a real result arrives (%s)",
    async (resolved) => {
      const { scope, cursor } = await createTranscript();
      await appendMessage(scope, processCall("poll"), "call");
      await appendMessage(
        scope,
        {
          role: "toolResult",
          toolCallId: "poll",
          toolName: "process",
          isError: true,
          details: { openclawSyntheticMissingToolResult: true, reason: "missing_tool_result" },
          content: [{ type: "text", text: "aborted" }],
        },
        "missing",
      );
      if (resolved) {
        await appendMessage(scope, { role: "assistant", content: [] }, "empty");
        await appendMessage(
          scope,
          {
            role: "toolResult",
            toolCallId: "poll",
            toolName: "process",
            isError: false,
            details: { status: "running", sessionId: "job", aggregated: "working" },
            content: [{ type: "text", text: "working" }],
          },
          "actual",
        );
      }
      const items = resolved ? [] : [{ status: "failed" }];
      expect(await readDelta(scope, cursor)).toMatchObject({
        kind: "delta",
        activity: [
          { messageId: "call", items },
          { messageId: "missing", items },
          ...(resolved ? [{ messageId: "actual", items: [] }] : []),
        ],
      });
    },
  );

  it.each([true, false])(
    "preserves reused call IDs (explicit run ownership: %s)",
    async (scoped) => {
      const { scope, cursor } = await createTranscript();
      for (const [runId, failed] of [
        ["failed-run", true],
        ["quiet-run", false],
      ] as const) {
        await appendMessage(
          scope,
          {
            ...processCall("same"),
            ...(scoped ? { __openclaw: { runId } } : {}),
          },
          `${runId}-call`,
        );
        await appendMessage(
          scope,
          {
            ...processResult(
              "same",
              {
                status: failed ? "failed" : "completed",
                sessionId: "job",
                aggregated: "output",
              },
              failed,
            ),
            ...(scoped ? { __openclaw: { runId } } : {}),
          },
          `${runId}-result`,
        );
      }
      const delta = await readDelta(scope, cursor);
      const unknownOutcome = { phase: "end", summary: "Outcome unknown" };
      expect(delta).toMatchObject({
        kind: "delta",
        activity: [
          {
            messageId: "failed-run-call",
            items: [scoped ? { status: "failed" } : unknownOutcome],
          },
          { messageId: "failed-run-result", items: [{ status: "failed" }] },
          { messageId: "quiet-run-call", items: scoped ? [] : [unknownOutcome] },
          { messageId: "quiet-run-result", items: [] },
        ],
      });
      assert(delta.kind === "delta", "Expected the reused-call delta");
      if (!scoped) {
        for (const entry of delta.activity.filter((item) => item.messageId.endsWith("-call"))) {
          expect(entry.items).toHaveLength(1);
          expect(entry.items[0]).not.toHaveProperty("status");
        }
      }
    },
  );

  it("keeps inactive stored calls unknown until their result is inside the history page", async () => {
    const { scope, cursor } = await createTranscript();
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }],
    };
    await appendMessage(scope, call, "stored-call");
    const savedCall = readTranscriptDisplayDelta(scope, { cursor });
    const pending = await readTail(scope);
    const pendingDelta = await readDelta(scope, cursor);
    expect(pending.messages).toMatchObject([call]);
    expect(pendingDelta).toMatchObject({
      kind: "delta",
      messages: [{ messageId: "stored-call", message: call }],
    });
    assert(pendingDelta.kind === "delta", "Expected the stored-call delta");
    for (const activity of [pending.activity, pendingDelta.activity]) {
      expect(activity).toMatchObject([
        {
          messageId: "stored-call",
          items: [{ toolCallId: "read-1", phase: "end", summary: "Outcome unknown" }],
        },
      ]);
      expect(activity?.[0]?.items[0]).not.toHaveProperty("status");
    }
    expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(savedCall);

    const result = {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "Saved notes" }],
    };
    await appendMessage(scope, result, "stored-result");
    const savedPair = readTranscriptDisplayDelta(scope, { cursor });
    const olderPage = await readTail(scope, 1, 1);
    expect(olderPage.messages).toMatchObject([call]);
    expect(olderPage.messages).toHaveLength(1);
    expect(olderPage.activity).toMatchObject([
      {
        messageId: "stored-call",
        items: [{ toolCallId: "read-1", phase: "end", summary: "Outcome unknown" }],
      },
    ]);
    expect(olderPage.activity?.[0]?.items[0]).not.toHaveProperty("status");

    const completed = { toolCallId: "read-1", phase: "end", status: "completed" };
    expect(await readDelta(scope, pendingDelta.deltaCursor)).toMatchObject({
      kind: "delta",
      messages: [{ messageId: "stored-result", message: result }],
      activity: [{ messageId: "stored-result", items: [completed] }],
    });
    const refreshedDelta = await readDelta(scope, cursor);
    assert(refreshedDelta.kind === "delta", "Expected the completed-call delta");
    for (const refreshed of [await readTail(scope), refreshedDelta]) {
      expect(refreshed.activity).toMatchObject([
        { messageId: "stored-call", items: [completed] },
        { messageId: "stored-result", items: [completed] },
      ]);
      expect(JSON.stringify(refreshed.activity)).not.toContain("Outcome unknown");
    }
    expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(savedPair);
  });

  it.each([
    [2, 0, undefined],
    [2, 1, undefined],
    [2, 0, 64 * 1024],
    [2, 1, 64 * 1024],
    [2, 0, 2 * maxBytes],
    [2, 1, 2 * maxBytes],
  ] as const)(
    "preserves the UTF-8 boundary with %i envelopes at limit + %i bytes (requested maxBytes: %s)",
    async (count, extraBytes, requestedMaxBytes) => {
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
      expect(
        Buffer.byteLength(serialized, "utf8") + chatHistoryActivityBytes(result.activity),
      ).toBe(byteLimit);
      expect(serialized).not.toContain("PRIVATE_REPLAY");
      expect(serialized).not.toContain("PRIVATE_UPSTREAM");
    },
  );
});

const failedAssistant = {
  role: "assistant",
  provider: "openai",
  model: "primary",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { runId: "run-recovery" },
};
const recoveredAssistant = {
  role: "assistant",
  provider: "openai",
  model: "backup",
  content: [{ type: "text", text: "Recovered answer" }],
  stopReason: "stop",
  __openclaw: { runId: "run-recovery" },
};

type TranscriptScope = Awaited<ReturnType<typeof createTranscript>>["scope"];

function readDelta(scope: TranscriptScope, cursor: string) {
  return readChatHistoryDelta({ agentId: "main", cursor, scope, sessionKey, sessionSnapshot });
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

describe("chat history custom reports", () => {
  it("delivers a committed failure notice once through the cursor and refreshed history", async () => {
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
      kind: "delta",
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
    assert(delta.kind === "delta", "Expected the committed report delta");
    expect(delta.messages).toHaveLength(2);
    const refreshed = await readTail(scope);
    expect(refreshed.pagination?.totalMessages).toBe(3);
    expect(refreshed.messages).toHaveLength(3);
    expect(refreshed.messages.slice(1)).toEqual(delta.messages.map((envelope) => envelope.message));
    expect(JSON.stringify(delta)).not.toContain("PRIVATE_");
    expect(JSON.stringify(refreshed.messages)).not.toContain("PRIVATE_");
    expect(await readDelta(scope, delta.deltaCursor)).toMatchObject({
      kind: "delta",
      messages: [],
      messagesBytes: 2,
      activityBytes: 0,
    });
  });
});

describe("chat history commentary cursor reconciliation", () => {
  it.each([false, true])(
    "preserves keyed commentary and its tool sibling on cursor refresh (tool=%s)",
    async (withTool) => {
      const { scope, cursor } = await createTranscript();
      const commentary = {
        type: "text",
        text: "First paragraph.\n\n- first file\n- second file",
        textSignature: JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" }),
      };
      const toolCall = {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "workspace.txt" },
      };
      const savedMessage = {
        role: "assistant",
        content: [commentary, ...(withTool ? [toolCall] : [])],
        stopReason: withTool ? "toolUse" : "stop",
        __openclaw: { runId: "run-commentary" },
      };
      await appendMessage(scope, savedMessage, "commentary-and-tool");

      // A saved cursor must not accept a partial envelope and permanently skip commentary.
      expect(await readDelta(scope, cursor)).toEqual({ kind: "reset" });
      const refreshed = await readTail(scope);
      expect(refreshed.messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: commentary.text }],
          openclawStreamFallback: { source: "segment", itemId: "commentary-1" },
        },
        ...(withTool ? [{ role: "assistant", content: [toolCall] }] : []),
      ]);
      expect(refreshed.messages).toHaveLength(withTool ? 2 : 1);
      expect(readTranscriptDisplayDelta(scope, { cursor })).toMatchObject({
        kind: "page",
        events: [{ event: { message: savedMessage } }],
      });
      assert(refreshed.deltaCursor, "Reconciled commentary must resume incremental history");
      await appendMessage(
        scope,
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        "final-answer",
      );
      expect(await readDelta(scope, refreshed.deltaCursor)).toMatchObject({
        kind: "delta",
        messages: [{ messageId: "final-answer", message: { content: [{ text: "Done." }] } }],
      });
    },
  );
});

describe("chat history quoted reply cursor reconciliation", () => {
  it("refreshes one enriched page for reply-bearing deltas and then resumes the cursor", async () => {
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
    expect(await readDelta(scope, initial.deltaCursor)).toEqual({ kind: "reset" });
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
    expect(await readDelta(scope, page.deltaCursor)).toMatchObject({ kind: "delta", messages: [] });
  });
});

describe("chat history channel mirror cursor reconciliation", () => {
  it.each(["before the answer", "between answer and mirror"])(
    "reconciles correlated replies with a cursor %s",
    async (position) => {
      const { scope, cursor } = await createTranscript();
      const answer = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check the opening hours." },
          { type: "text", text: "The observatory opens at seven." },
        ],
      };
      await appendMessage(scope, answer, "answer-1");
      const firstAnswer = await readDelta(scope, cursor);
      assert(firstAnswer.kind === "delta", "The ordinary answer must support incremental history");
      const mirror = {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "The observatory opens at seven." }],
        openclawDeliveryMirror: {
          kind: "channel-final",
          sourceAssistantMessageId: "answer-1",
        },
      };
      await appendMessage(scope, mirror, "mirror-1");
      const saved = readTranscriptDisplayDelta(scope, { cursor });

      expect(
        await readDelta(scope, position === "before the answer" ? cursor : firstAnswer.deltaCursor),
      ).toEqual({ kind: "reset" });
      const refreshed = await readTail(scope);
      expect(refreshed.messages).toMatchObject([{ __openclaw: { id: "answer-1" } }]);
      expect(refreshed.messages).toHaveLength(1);
      expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(saved);
      assert(refreshed.deltaCursor, "Reconciled mirrors must resume incremental history");

      await appendMessage(scope, answer, "answer-2");
      await appendMessage(
        scope,
        {
          ...mirror,
          openclawDeliveryMirror: { kind: "channel-final", sourceAssistantMessageId: "answer-2" },
        },
        "mirror-2",
      );
      expect(await readDelta(scope, refreshed.deltaCursor)).toEqual({ kind: "reset" });
      const reconciled = await readTail(scope);
      expect(reconciled.messages).toMatchObject([
        { __openclaw: { id: "answer-1" } },
        { __openclaw: { id: "answer-2" } },
      ]);
      expect(reconciled.messages).toHaveLength(2);
      expect(reconciled.deltaCursor).toEqual(expect.any(String));
    },
  );
  it.each([
    { name: "legacy identity", legacyIdentity: true, media: false, expectedIds: ["source"] },
    {
      name: "fieldless history",
      legacyIdentity: false,
      media: false,
      expectedIds: ["source", "mirror"],
    },
    { name: "media reply", legacyIdentity: false, media: true, expectedIds: ["source", "mirror"] },
  ])(
    "preserves $name through full reconciliation",
    async ({ legacyIdentity, media, expectedIds }) => {
      const { scope, cursor } = await createTranscript();
      await appendMessage(
        scope,
        {
          role: "assistant",
          content: [
            { type: "text", text: "The observatory opens at seven." },
            ...(media
              ? [{ type: "image", source: { type: "url", url: "https://example.test/chart.png" } }]
              : []),
          ],
          ...(legacyIdentity ? { __openclaw: { mirrorIdentity: "legacy-answer" } } : {}),
        },
        "source",
      );
      await appendMessage(
        scope,
        {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "The observatory opens at seven." }],
          openclawDeliveryMirror: {
            kind: "channel-final",
            ...(media ? { sourceAssistantMessageId: "source" } : {}),
          },
        },
        "mirror",
      );
      const saved = readTranscriptDisplayDelta(scope, { cursor });
      expect(await readDelta(scope, cursor)).toEqual({ kind: "reset" });
      const refreshed = await readTail(scope);
      expect(refreshed.messages).toHaveLength(expectedIds.length);
      expect(refreshed.messages).toMatchObject(expectedIds.map((id) => ({ __openclaw: { id } })));
      expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(saved);
    },
  );
});

describe("chat history recovery cursor eligibility", () => {
  it.each([undefined, 0])(
    "keeps refreshes authoritative while a tail error can recover (offset=%s)",
    async (offset) => {
      const { scope, cursor } = await createTranscript();
      await appendMessage(scope, failedAssistant, "failed-attempt");
      expect(await readDelta(scope, cursor)).toEqual({ kind: "reset" });

      const pending = await readTail(scope, offset);
      expect(pending.messages).toEqual([]);
      expect(pending).not.toHaveProperty("deltaCursor");

      await appendMessage(scope, recoveredAssistant, "recovered-answer");
      const recovered = await readTail(scope, offset);
      expect(recovered.messages).toEqual([
        expect.objectContaining({
          __openclaw: expect.objectContaining({ id: "recovered-answer" }),
        }),
      ]);
      expect(recovered.deltaCursor).toEqual(expect.any(String));
      assert(recovered.deltaCursor, "Recovered history must resume incremental updates");

      await appendMessage(scope, { role: "user", content: "next turn" }, "next-user");
      await appendMessage(
        scope,
        { ...recoveredAssistant, __openclaw: { runId: "run-next" } },
        "next-answer",
      );
      expect(await readDelta(scope, recovered.deltaCursor)).toMatchObject({
        kind: "delta",
        deltaCursor: expect.any(String),
        messages: [{ messageId: "next-user" }, { messageId: "next-answer" }],
      });
    },
  );
});

describe("chat history TTS supplement cursor reconciliation", () => {
  it("resets the cursor refresh so the supplement merges into the visible reply", async () => {
    const { scope, cursor } = await createTranscript();
    const visibleText = "Plain recon 4101 stays visible.";
    const attachment = {
      type: "attachment",
      attachment: { kind: "audio", label: "reply.wav", mimeType: "audio/wav" },
    };
    await appendMessage(
      scope,
      { role: "assistant", content: [{ type: "text", text: visibleText }] },
      "answer",
    );
    const answerDelta = await readDelta(scope, cursor);
    assert(answerDelta.kind === "delta", "Expected the answer delta");

    const appended = await appendInjectedAssistantMessageToTranscript({
      ...scope,
      message: "Audio reply",
      content: [{ type: "text", text: "Audio reply" }, attachment],
      ttsSupplement: {
        textSha256: createHash("sha256").update(visibleText).digest("hex"),
      },
    });
    expect(appended.ok).toBe(true);

    expect(await readDelta(scope, answerDelta.deltaCursor)).toEqual({ kind: "reset" });
    const refreshed = await readTail(scope);
    expect(refreshed.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "text", text: visibleText }, attachment],
      },
    ]);
    expect(refreshed.messages).toHaveLength(1);
    expect(refreshed.deltaCursor).toEqual(expect.any(String));
  });
});
