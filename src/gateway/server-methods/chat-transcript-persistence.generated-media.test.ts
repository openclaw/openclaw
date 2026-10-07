import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessageSync,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { enrichAssistantTranscriptMediaForRun } from "./chat-transcript-persistence.js";

const RUN_ID = "generated-media-completion";
const MESSAGE_ID = "completion-answer";

async function withTranscriptFixture(
  lifecycleRevision: SessionLifecycleRevisionExpectation,
  run: (fixture: {
    scope: {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      env: NodeJS.ProcessEnv;
    };
    enrich: (runId?: string) => ReturnType<typeof enrichAssistantTranscriptMediaForRun>;
    snapshot: () => {
      rows: Array<{ seq: number; eventJson: string; event: Record<string, unknown> }>;
      watermark: ReturnType<typeof readSessionTranscriptWatermark>;
    };
    mediaBlock: Record<string, unknown>;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "generated-media-transcript" }, async (state) => {
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
    const messages = [
      {
        eventId: "older-answer",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "An earlier answer." }],
          stopReason: "stop",
          __openclaw: { runId: "older-run" },
        },
      },
      {
        eventId: "request",
        message: { role: "user", content: [{ type: "text", text: "Make an avatar sheet." }] },
      },
      {
        eventId: "generation-tool-call",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Preparing the sheet.", textSignature: "signed-progress" },
            { type: "toolCall", id: "generate-call", name: "image_generate", arguments: {} },
          ],
          stopReason: "toolUse",
          __openclaw: { runId: RUN_ID },
        },
      },
      {
        eventId: "generation-tool-result",
        message: {
          role: "toolResult",
          toolCallId: "generate-call",
          toolName: "image_generate",
          content: [{ type: "text", text: "Generated one image." }],
          __openclaw: { runId: RUN_ID },
        },
      },
      {
        eventId: MESSAGE_ID,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Synthetic reasoning.", thinkingSignature: "opaque" },
            { type: "text", text: "Here are four options.\n", textSignature: "signed-caption" },
            { type: "text", text: `MEDIA:${mediaUrl}`, textSignature: "signed-media" },
            { type: "text", text: "\nPick 1, 2, 3, or 4.", textSignature: "signed-choice" },
          ],
          stopReason: "stop",
          openclawDelivery: { replyToCurrent: true },
          __openclaw: { runId: RUN_ID },
        },
      },
      {
        eventId: "later-request",
        message: { role: "user", content: [{ type: "text", text: "Show that sheet again." }] },
      },
      {
        eventId: "later-answer",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `The same sheet, in a later turn.\nMEDIA:${mediaUrl}` }],
          stopReason: "stop",
          __openclaw: { runId: "later-run" },
        },
      },
    ];
    for (const [index, { eventId, message }] of messages.entries()) {
      expect(
        appendTranscriptMessageSync(scope, { eventId, message, now: 1_000 + index }),
      ).toMatchObject({
        ok: true,
        value: { appended: true, messageId: eventId },
      });
    }
    const snapshot = () => {
      const database = openOpenClawAgentDatabase(scope);
      const rows = database.db
        .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId)
        .map((row) => {
          if (typeof row.seq !== "number" || typeof row.event_json !== "string") {
            throw new Error("invalid transcript fixture row");
          }
          const event: unknown = JSON.parse(row.event_json);
          if (!isRecord(event)) {
            throw new Error("invalid transcript fixture event");
          }
          return { seq: row.seq, eventJson: row.event_json, event };
        });
      return { rows, watermark: readSessionTranscriptWatermark(scope) };
    };
    await run({
      scope,
      snapshot,
      mediaBlock,
      enrich: (runId = RUN_ID) =>
        enrichAssistantTranscriptMediaForRun({
          scope,
          runId,
          expectedLifecycleRevision: lifecycleRevision,
          content: [mediaBlock],
          mediaUrls: [mediaUrl],
        }),
    });
  });
}

describe("generated-media transcript enrichment", () => {
  it.each([null, "initial-revision"])(
    "enriches only its run's reply and preserves model bytes through replay (revision=%s)",
    async (revision) => {
      await withTranscriptFixture(revision, async ({ enrich, snapshot, mediaBlock }) => {
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
          if (!rewritten || !isRecord(row.event.message) || !isRecord(rewritten.event.message)) {
            throw new Error("completion message missing from fixture");
          }
          const { message: _originalMessage, ...originalEnvelope } = row.event;
          const { message: _rewrittenMessage, ...rewrittenEnvelope } = rewritten.event;
          expect(rewritten.seq).toBe(row.seq);
          expect(rewrittenEnvelope).toEqual(originalEnvelope);
          expect(rewritten.event.message.content).toEqual(row.event.message.content);
          expect(rewritten.event.message.openclawDelivery).toMatchObject({ replyToCurrent: true });
          const display = rewritten.event.message.openclawDisplayContent;
          if (!Array.isArray(display)) {
            throw new Error("completion display content missing");
          }
          expect(display.filter((block) => isRecord(block) && block.type === "image")).toEqual([
            mediaBlock,
          ]);
          const displayText = display.flatMap((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          );
          expect(displayText.map((text) => text.trim())).toEqual([
            "Here are four options.",
            "Pick 1, 2, 3, or 4.",
          ]);
        }

        await expect(enrich()).resolves.toEqual({ messageId: MESSAGE_ID });
        expect(snapshot()).toEqual(after);
      });
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
    {
      label: "session replacement",
      captured: "initial-revision",
      sessionId: "replacement-session",
      lifecycleRevision: "initial-revision",
    },
    {
      label: "same-session revision change",
      captured: "initial-revision",
      sessionId: "media-session",
      lifecycleRevision: "replacement-revision",
    },
    {
      label: "previously absent revision",
      captured: null,
      sessionId: "media-session",
      lifecycleRevision: "replacement-revision",
    },
  ])("rejects stale media after $label", async ({ captured, sessionId, lifecycleRevision }) => {
    await withTranscriptFixture(captured, async ({ scope, enrich, snapshot }) => {
      await replaceSessionEntry(scope, {
        sessionId,
        lifecycleRevision,
        updatedAt: 2,
      });
      const before = snapshot();
      await expect(enrich()).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      expect(snapshot()).toEqual(before);
    });
  });
});
