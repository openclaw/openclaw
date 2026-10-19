import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { enrichAssistantTranscriptMediaForRun } from "./chat-transcript-persistence.js";

const RUN_ID = "generated-media-completion";
const MESSAGE_ID = "completion-answer";
const caption = "Here are four options.";
const choice = "Pick 1, 2, 3, or 4.";
const warningText = "Synthetic attachment warning.";
const text = (value: string, textSignature?: string) => ({
  type: "text",
  text: value,
  ...(textSignature ? { textSignature } : {}),
});
type Content = Record<string, unknown>[];
const transcriptEvent = (eventId: string, role: string, content: Content, extra = {}) => ({
  eventId,
  message: { role, content, ...extra },
});
const assistant = (eventId: string, content: Content, runId = RUN_ID, extra = {}) =>
  transcriptEvent(eventId, "assistant", content, {
    stopReason: "stop",
    __openclaw: { runId },
    ...extra,
  });
function displayOrder(display: unknown[]) {
  return display.map((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? block.text.trim()
      : isRecord(block)
        ? block.type
        : undefined,
  );
}

async function withTranscriptFixture(
  lifecycleRevision: SessionLifecycleRevisionExpectation,
  run: (fixture: Awaited<ReturnType<typeof seedTranscript>>) => Promise<void>,
  singleText = false,
): Promise<void> {
  await withOpenClawTestState({ label: "generated-media-transcript" }, async (state) => {
    await run(await seedTranscript(state, lifecycleRevision, singleText));
  });
}

async function seedTranscript(
  state: OpenClawTestState,
  lifecycleRevision: SessionLifecycleRevisionExpectation,
  singleText: boolean,
) {
  setRuntimeConfigSnapshot({});
  const scope = {
    agentId: "main",
    sessionId: "media-session",
    sessionKey: "agent:main:generated-media",
    env: state.env,
  };
  await replaceSessionEntry(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    ...(lifecycleRevision === null ? {} : { lifecycleRevision }),
  });
  const mediaUrl = state.statePath("media", "generated-sheet.png");
  const mediaBlock = {
    type: "image",
    artifactId: "artifact_managed_image_generated-sheet",
    url: "/api/chat/media/outgoing/agent%3Amain%3Agenerated-media/generated-sheet/full",
    alt: "generated-sheet.png",
    mimeType: "image/png",
  };
  const warning = text(warningText);
  const mediaGroup = singleText ? [mediaBlock, warning] : [mediaBlock];
  const messages = [
    assistant("older-answer", [text("An earlier answer.")], "older-run"),
    transcriptEvent("request", "user", [text("Make an avatar sheet.")]),
    assistant(
      "generation-tool-call",
      [
        text("Preparing the sheet.", "signed-progress"),
        { type: "toolCall", id: "generate-call", name: "image_generate", arguments: {} },
      ],
      RUN_ID,
      { stopReason: "toolUse" },
    ),
    transcriptEvent("generation-tool-result", "toolResult", [text("Generated one image.")], {
      toolCallId: "generate-call",
      toolName: "image_generate",
      __openclaw: { runId: RUN_ID },
    }),
    assistant(
      MESSAGE_ID,
      singleText
        ? [
            text(
              `[[reply_to_current]]\n${caption}\nMEDIA:${mediaUrl}\nMEDIA:${mediaUrl}\n${choice}`,
              JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
            ),
          ]
        : [
            { type: "thinking", thinking: "Synthetic reasoning.", thinkingSignature: "opaque" },
            text(`${caption}\n`, "signed-caption"),
            text(`MEDIA:${mediaUrl}`, "signed-media"),
            text(`\n${choice}`, "signed-choice"),
          ],
      RUN_ID,
      { openclawDelivery: { replyToCurrent: true } },
    ),
    transcriptEvent("later-request", "user", [text("Show that sheet again.")]),
    assistant(
      "later-answer",
      [text(`The same sheet, in a later turn.\nMEDIA:${mediaUrl}`)],
      "later-run",
    ),
  ];
  for (const [index, { eventId, message }] of messages.entries()) {
    const result = appendTranscriptMessageSync(scope, { eventId, message, now: 1_000 + index });
    expect(result).toMatchObject({ ok: true, value: { appended: true, messageId: eventId } });
  }
  const snapshot = () => {
    const database = openOpenClawAgentDatabase(scope);
    const rows = database.db
      .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId)
      .map((row) => {
        assert(typeof row.seq === "number" && typeof row.event_json === "string");
        const event: unknown = JSON.parse(row.event_json);
        assert(isRecord(event));
        return { seq: row.seq, eventJson: row.event_json, event };
      });
    return { rows, watermark: readSessionTranscriptWatermark(scope) };
  };
  return {
    scope,
    snapshot,
    mediaBlock,
    enrich: (runId = RUN_ID) =>
      enrichAssistantTranscriptMediaForRun({
        scope,
        runId,
        expectedLifecycleRevision: lifecycleRevision,
        content: [text([caption, choice].join(singleText ? "\n" : "\n\n\n")), ...mediaGroup],
        mediaBySource: new Map([[mediaUrl, mediaGroup]]),
        mediaUrls: [mediaUrl],
      }),
  };
}

describe("generated-media transcript enrichment", () => {
  it.each([
    [null, false],
    ["initial-revision", false],
    ["initial-revision", true],
  ] as const)(
    "preserves signed captions, media order, warnings, and replay (revision=%s, singleText=%s)",
    async (revision, singleText) => {
      await withTranscriptFixture(
        revision,
        async ({ enrich, snapshot, mediaBlock }) => {
          const before = snapshot();
          await expect(enrich()).resolves.toEqual({ messageId: MESSAGE_ID });
          const after = snapshot();
          expect(after.rows).toHaveLength(before.rows.length);
          expect(after.watermark.maxSeq).toBe(before.watermark.maxSeq);
          expect(after.watermark.generation).not.toBe(before.watermark.generation);
          for (const [index, row] of before.rows.entries()) {
            const rewritten = after.rows[index];
            if (row.event.id !== MESSAGE_ID) {
              expect(rewritten).toEqual(row);
              continue;
            }
            assert(rewritten && isRecord(row.event.message) && isRecord(rewritten.event.message));
            const { message: _originalMessage, ...originalEnvelope } = row.event;
            const { message: _rewrittenMessage, ...rewrittenEnvelope } = rewritten.event;
            expect(rewritten.seq).toBe(row.seq);
            expect(rewrittenEnvelope).toEqual(originalEnvelope);
            expect(rewritten.event.message.content).toEqual(row.event.message.content);
            expect(rewritten.event.message.openclawDelivery).toMatchObject({
              replyToCurrent: true,
            });
            const display = rewritten.event.message.openclawDisplayContent;
            assert(Array.isArray(display));
            expect(display.filter((block) => isRecord(block) && block.type === "image")).toEqual([
              mediaBlock,
            ]);
            expect(
              displayOrder(display.filter((block) => isRecord(block) && block.type !== "thinking")),
            ).toEqual([caption, "image", ...(singleText ? [warningText] : []), choice]);
          }

          await expect(enrich()).resolves.toEqual({ messageId: MESSAGE_ID });
          expect(snapshot()).toEqual(after);
        },
        singleText,
      );
    },
  );

  it("leaves the transcript unchanged when the requested run has no assistant reply", async () => {
    await withTranscriptFixture("initial-revision", async ({ enrich, snapshot }) => {
      const before = snapshot();
      await expect(enrich("missing-run")).resolves.toBeNull();
      expect(snapshot()).toEqual(before);
    });
  });

  it.each([
    ["session replacement", "initial-revision", "replacement-session", "initial-revision"],
    ["same-session revision change", "initial-revision", "media-session", "replacement-revision"],
    ["previously absent revision", null, "media-session", "replacement-revision"],
  ] as const)(
    "rejects stale media after %s",
    async (_label, captured, sessionId, lifecycleRevision) => {
      await withTranscriptFixture(captured, async ({ scope, enrich, snapshot }) => {
        await replaceSessionEntry(scope, { sessionId, lifecycleRevision, updatedAt: 2 });
        const before = snapshot();
        await expect(enrich()).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(snapshot()).toEqual(before);
      });
    },
  );
});
