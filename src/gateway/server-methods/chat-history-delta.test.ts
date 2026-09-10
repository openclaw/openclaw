import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendSessionTranscriptReport,
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const maxBytes = 1_000_000;
const sessionKey = "agent:main:delta-budget";
const sessionId = "delta-budget-session";
const sessionSnapshot = buildGatewaySessionSnapshot({
  agentId: "main",
  includeSession: true,
  sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 42 },
});

async function createTranscript() {
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(tempDirs.make("openclaw-delta-budget-"), "sessions.json"),
  };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 42 });
  await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: sessionId }]);
  const head = readTranscriptDisplayDelta(scope);
  if (head.kind !== "page") {
    throw new Error("Expected an initial transcript cursor");
  }
  return { scope, cursor: head.cursor };
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
        content,
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
  if (raw.kind !== "page") {
    throw new Error("Expected a complete raw delta");
  }
  expect(raw.serializedBytes).toBeLessThan(byteLimit);
  expect(JSON.stringify(raw.events)).toContain("PRIVATE_REPLAY");
  return readChatHistoryDelta({
    agentId: "main",
    cursor,
    maxBytes: requestedMaxBytes,
    scope,
    sessionKey,
    sessionSnapshot,
  });
}

describe("chat history delta display budget", () => {
  it.each([
    [1, 0, undefined],
    [1, 1, undefined],
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
      if (small.kind !== "delta") {
        throw new Error("Expected the small delta");
      }
      contents[0] =
        prefix +
        "x".repeat(
          byteLimit - Buffer.byteLength(JSON.stringify(small.messages), "utf8") + extraBytes,
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
          message: { content },
        })),
      });
      if (result.kind !== "delta") {
        throw new Error("Expected the exact-limit delta");
      }
      const serialized = JSON.stringify(result.messages);
      expect(Buffer.byteLength(serialized, "utf8")).toBe(byteLimit);
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

function readTail(scope: TranscriptScope, offset?: number) {
  return readChatHistoryPage({
    entry: { sessionId, updatedAt: 42 },
    provider: "openai",
    sessionId,
    storePath: scope.storePath,
    sessionAgentId: "main",
    canonicalKey: sessionKey,
    max: 20,
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
    await appendTranscriptMessage(scope, {
      eventId: "question",
      message: { role: "user", content: "Please help." },
    });
    const before = await readTail(scope);
    if (!before.deltaCursor) {
      throw new Error("Expected a cursor before the failure report");
    }
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
    await appendTranscriptMessage(scope, {
      eventId: "follow-up",
      message: { role: "user", content: "Please try again." },
    });

    const delta = readDelta(scope, before.deltaCursor);
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
    if (delta.kind !== "delta") {
      throw new Error("Expected the committed report delta");
    }
    expect(delta.messages).toHaveLength(2);
    const refreshed = await readTail(scope);
    expect(refreshed.pagination?.totalMessages).toBe(3);
    expect(refreshed.messages).toHaveLength(3);
    expect(refreshed.messages.slice(1)).toEqual(delta.messages.map((envelope) => envelope.message));
    expect(JSON.stringify(delta)).not.toContain("PRIVATE_");
    expect(JSON.stringify(refreshed.messages)).not.toContain("PRIVATE_");
    expect(readDelta(scope, delta.deltaCursor)).toMatchObject({ kind: "delta", messages: [] });
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
      await appendTranscriptMessage(scope, {
        eventId: "commentary-and-tool",
        message: savedMessage,
      });

      // A saved cursor must not accept a partial envelope and permanently skip commentary.
      expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });
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
      if (!refreshed.deltaCursor) {
        throw new Error("Reconciled commentary must resume incremental history");
      }
      await appendTranscriptMessage(scope, {
        eventId: "final-answer",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      });
      expect(readDelta(scope, refreshed.deltaCursor)).toMatchObject({
        kind: "delta",
        messages: [{ messageId: "final-answer", message: { content: [{ text: "Done." }] } }],
      });
    },
  );
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
      await appendTranscriptMessage(scope, { eventId: "answer-1", message: answer });
      const firstAnswer = readDelta(scope, cursor);
      if (firstAnswer.kind !== "delta") {
        throw new Error("The ordinary answer must support incremental history");
      }
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
      await appendTranscriptMessage(scope, { eventId: "mirror-1", message: mirror });
      const saved = readTranscriptDisplayDelta(scope, { cursor });

      expect(
        readDelta(scope, position === "before the answer" ? cursor : firstAnswer.deltaCursor),
      ).toEqual({ kind: "reset" });
      const refreshed = await readTail(scope);
      expect(refreshed.messages).toMatchObject([{ __openclaw: { id: "answer-1" } }]);
      expect(refreshed.messages).toHaveLength(1);
      expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual(saved);
      if (!refreshed.deltaCursor) {
        throw new Error("Reconciled mirrors must resume incremental history");
      }

      await appendTranscriptMessage(scope, { eventId: "answer-2", message: answer });
      await appendTranscriptMessage(scope, {
        eventId: "mirror-2",
        message: {
          ...mirror,
          openclawDeliveryMirror: { kind: "channel-final", sourceAssistantMessageId: "answer-2" },
        },
      });
      expect(readDelta(scope, refreshed.deltaCursor)).toEqual({ kind: "reset" });
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
      await appendTranscriptMessage(scope, {
        eventId: "source",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The observatory opens at seven." },
            ...(media
              ? [{ type: "image", source: { type: "url", url: "https://example.test/chart.png" } }]
              : []),
          ],
          ...(legacyIdentity ? { __openclaw: { mirrorIdentity: "legacy-answer" } } : {}),
        },
      });
      await appendTranscriptMessage(scope, {
        eventId: "mirror",
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "The observatory opens at seven." }],
          openclawDeliveryMirror: {
            kind: "channel-final",
            ...(media ? { sourceAssistantMessageId: "source" } : {}),
          },
        },
      });
      const saved = readTranscriptDisplayDelta(scope, { cursor });
      expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });
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
      await appendTranscriptMessage(scope, {
        eventId: "failed-attempt",
        message: failedAssistant,
      });
      expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });

      const pending = await readTail(scope, offset);
      expect(pending.messages).toContainEqual(
        expect.objectContaining({ __openclaw: expect.objectContaining({ id: "failed-attempt" }) }),
      );
      expect(pending).not.toHaveProperty("deltaCursor");

      await appendTranscriptMessage(scope, {
        eventId: "recovered-answer",
        message: recoveredAssistant,
      });
      const recovered = await readTail(scope, offset);
      expect(recovered.messages).toEqual([
        expect.objectContaining({
          __openclaw: expect.objectContaining({ id: "recovered-answer" }),
        }),
      ]);
      expect(recovered.deltaCursor).toEqual(expect.any(String));
      if (!recovered.deltaCursor) {
        throw new Error("Recovered history must resume incremental updates");
      }

      await appendTranscriptMessage(scope, {
        eventId: "next-user",
        message: { role: "user", content: "next turn" },
      });
      await appendTranscriptMessage(scope, {
        eventId: "next-answer",
        message: { ...recoveredAssistant, __openclaw: { runId: "run-next" } },
      });
      expect(readDelta(scope, recovered.deltaCursor)).toMatchObject({
        kind: "delta",
        deltaCursor: expect.any(String),
        messages: [{ messageId: "next-user" }, { messageId: "next-answer" }],
      });
    },
  );

  it.each([
    ["empty provider failure", failedAssistant],
    [
      "legacy stream placeholder",
      {
        ...failedAssistant,
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      },
    ],
  ])("resets a single delta containing %s and its recovered answer", async (_name, failure) => {
    const { scope, cursor } = await createTranscript();
    await appendTranscriptMessage(scope, { eventId: "failed-attempt", message: failure });
    await appendTranscriptMessage(scope, {
      eventId: "recovered-answer",
      message: recoveredAssistant,
    });

    expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });
    const recovered = await readTail(scope);
    expect(recovered.messages).toEqual([
      expect.objectContaining({ __openclaw: expect.objectContaining({ id: "recovered-answer" }) }),
    ]);
    expect(recovered.deltaCursor).toEqual(expect.any(String));
  });

  it("retains incremental delivery for failed attempts with visible partial output", async () => {
    const { scope, cursor } = await createTranscript();
    await appendTranscriptMessage(scope, {
      eventId: "partial-failure",
      message: { ...failedAssistant, content: [{ type: "text", text: "Partial answer" }] },
    });
    expect(readDelta(scope, cursor)).toMatchObject({
      kind: "delta",
      messages: [{ messageId: "partial-failure" }],
    });
    expect((await readTail(scope)).deltaCursor).toEqual(expect.any(String));
  });
});
