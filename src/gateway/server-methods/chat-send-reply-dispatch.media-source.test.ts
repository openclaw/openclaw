import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { sessionManagerReadTranscriptStart } from "../../agents/sessions/session-manager-current-turn.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { setReplyPayloadMetadata, type ReplyMediaFailure } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { TINY_PNG_BASE64 } from "./chat-message.test-fixtures.js";
import { createReplyTranscriptFixture } from "./chat-send-reply-dispatch.test-support.js";

it.each(["identical", "streamed-tail", "superseded-media", "suppressed-append"] as const)(
  "finalizes distinct assistant media occurrences without index ownership (%s)",
  async (scenario) => {
    await withOpenClawTestState({ label: "chat-media-source" }, async (state) => {
      const { scope, runId, append, dispatch } = await createReplyTranscriptFixture();
      await fs.mkdir(state.statePath("media"), { recursive: true });
      const mediaUrl = state.statePath("media", "preview.png");
      await fs.writeFile(mediaUrl, Buffer.from(TINY_PNG_BASE64, "base64"));
      const canonical = new Map<string, Record<string, unknown>>();
      const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
      const manager = await SessionManager.openAsync(scope);
      await dispatch.runAgentMediaTranscript(
        { run: async (operation) => operation() },
        async () => {
          expect(
            dispatch.captureAgentTranscriptStart(
              runId,
              manager[sessionManagerReadTranscriptStart](),
            ),
          ).toBe(true);
          for (const messageId of ["first-response", "later-response"]) {
            const text = `Full identical answer.\nMEDIA:${mediaUrl}`;
            const message = {
              role: "assistant",
              responseId: messageId,
              content: [
                {
                  type: "text",
                  text,
                  textSignature: JSON.stringify({ v: 1, id: messageId, phase: "final_answer" }),
                },
              ],
            };
            const source = { occurrenceId: messageId, messageId: undefined as string | undefined };
            if (scenario !== "suppressed-append") {
              await append(messageId, message);
              source.messageId = messageId;
              canonical.set(messageId, message);
            }
            // Real retries can reuse the same index; media-only suppression and
            // streamed tails retain this physical occurrence, not text identity.
            const payload = setReplyPayloadMetadata(
              {
                text:
                  scenario === "superseded-media"
                    ? undefined
                    : scenario === "streamed-tail"
                      ? "answer."
                      : "Full identical answer.",
                mediaUrl,
                mediaUrls: [mediaUrl],
              },
              {
                assistantMessageIndex: 3,
                assistantTranscriptSource: source,
                assistantTranscriptMediaUrls: [mediaUrl],
              },
            );
            dispatcher.sendBlockReply(payload);
          }
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        },
      );
      expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(true);
      const messages = loadTranscriptEventsSync(scope).flatMap((event) =>
        isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
          ? [{ id: event.id, message: event.message }]
          : [],
      );
      expect(messages).toHaveLength(2);
      for (const { id, message } of messages) {
        const display = message.openclawDisplayContent;
        expect(Array.isArray(display)).toBe(true);
        const blocks = Array.isArray(display) ? display : [];
        expect(blocks.filter((block) => isRecord(block) && block.type === "image")).toHaveLength(1);
        if (scenario === "suppressed-append") {
          expect(message.content).toEqual([]);
          expect(blocks.filter((block) => isRecord(block) && block.type === "text")).toEqual([]);
          expect(message.idempotencyKey).toMatch(
            /:assistant-media:(first|later)-response:index:3$/,
          );
        } else {
          expect(message.content).toEqual(canonical.get(String(id))?.content);
          expect(message.responseId).toBe(id);
          expect(blocks.filter((block) => isRecord(block) && block.type === "text")).toEqual([
            { type: "text", text: "Full identical answer." },
          ]);
        }
      }
    });
  },
);
it.each([
  "uncommitted-unwind",
  "committed-unwind",
  "index-only-unwind",
  "identical-url-unwind",
  "repeated-index",
  "completed-aggregate",
  "completed-aggregate-first-index",
] as const)("retains delivered media within one assistant occurrence (%s)", async (scenario) => {
  await withOpenClawTestState({ label: "chat-media-content-index" }, async (state) => {
    const isCompletedAggregate = scenario.startsWith("completed-aggregate");
    const { scope, runId, append, dispatch } = await createReplyTranscriptFixture();
    await fs.mkdir(state.statePath("media"), { recursive: true });
    const mediaUrls = [
      state.statePath("media", "first.png"),
      state.statePath("media", scenario === "identical-url-unwind" ? "first.png" : "second.png"),
    ];
    for (const mediaUrl of mediaUrls) {
      await fs.writeFile(mediaUrl, Buffer.from(TINY_PNG_BASE64, "base64"));
    }
    const source = { occurrenceId: "shared-response", messageId: undefined as string | undefined };
    const canonical = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: mediaUrls.map((url) => `MEDIA:${url}`).join("\n"),
          textSignature: "provider-signature",
        },
      ],
    };
    const manager = await SessionManager.openAsync(scope);
    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    const operation = dispatch.runAgentMediaTranscript({ run: async (run) => run() }, async () => {
      expect(
        dispatch.captureAgentTranscriptStart(runId, manager[sessionManagerReadTranscriptStart]()),
      ).toBe(true);
      if (scenario === "committed-unwind" || isCompletedAggregate) {
        await append("canonical-response", canonical);
        source.messageId = "canonical-response";
      }
      for (const [index, mediaUrl] of mediaUrls.entries()) {
        dispatcher.sendBlockReply(
          setReplyPayloadMetadata(
            { mediaUrl, mediaUrls: [mediaUrl] },
            {
              assistantMessageIndex: scenario === "repeated-index" ? 1 : index + 1,
              assistantTranscriptSource: scenario === "index-only-unwind" ? undefined : source,
              assistantTranscriptMediaUrls: [mediaUrl],
            },
          ),
        );
      }
      if (isCompletedAggregate) {
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata(
            { mediaUrls },
            {
              assistantMessageIndex: scenario === "completed-aggregate-first-index" ? 1 : 2,
              assistantTranscriptSource: source,
              assistantTranscriptMediaUrls: mediaUrls,
              assistantTranscriptAggregate: true,
            },
          ),
        );
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      if (scenario.endsWith("unwind")) {
        // A provider operation can unwind before message_end without revoking
        // the still-admitted turn's transcript write authority.
        throw new Error("provider operation ended before aggregate");
      }
    });
    if (scenario.endsWith("unwind")) {
      await expect(operation).rejects.toThrow("provider operation ended before aggregate");
    } else {
      await operation;
    }
    const messages = loadTranscriptEventsSync(scope).flatMap((event) =>
      isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
        ? [{ id: event.id, message: event.message }]
        : [],
    );
    const imageBlocks = messages.flatMap(({ message }) =>
      Array.isArray(message.openclawDisplayContent)
        ? message.openclawDisplayContent.filter(
            (block) => isRecord(block) && block.type === "image",
          )
        : [],
    );
    expect(imageBlocks).toHaveLength(scenario === "repeated-index" ? 1 : 2);
    if (scenario !== "repeated-index" && scenario !== "identical-url-unwind") {
      expect(new Set(imageBlocks.map((block) => JSON.stringify(block))).size).toBe(2);
    }
    if (isCompletedAggregate) {
      expect(messages).toHaveLength(1);
    }
    if (source.messageId) {
      expect(messages.find(({ id }) => id === source.messageId)?.message.content).toEqual(
        canonical.content,
      );
    }
    for (const { id, message } of messages) {
      if (id !== source.messageId) {
        expect(message.content).toEqual([]);
      }
    }
  });
});
it.each(["distinct", "equal"] as const)(
  "retains delivered failure cards across content indices (%s)",
  async (scenario) => {
    await withOpenClawTestState({ label: "chat-media-failure-indices" }, async () => {
      const { scope, runId, dispatch } = await createReplyTranscriptFixture();
      const manager = await SessionManager.openAsync(scope);
      const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
      const failures: ReplyMediaFailure[] = [
        { code: "invalid-reference", kind: "image", label: "first-invalid-image" },
        {
          code: "invalid-reference",
          kind: "image",
          label: scenario === "equal" ? "first-invalid-image" : "second-invalid-image",
        },
      ];
      await dispatch.runAgentMediaTranscript({ run: async (run) => run() }, async () => {
        expect(
          dispatch.captureAgentTranscriptStart(runId, manager[sessionManagerReadTranscriptStart]()),
        ).toBe(true);
        for (const [index, failure] of failures.entries()) {
          dispatcher.sendBlockReply(
            setReplyPayloadMetadata(
              { text: "Attachment failed." },
              {
                assistantMessageIndex: index + 1,
                assistantTranscriptSource: { occurrenceId: "shared-failures" },
                assistantMediaFailures: [failure],
              },
            ),
          );
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      });
      const failureBlocks = loadTranscriptEventsSync(scope).flatMap((event) => {
        if (
          !isRecord(event) ||
          !isRecord(event.message) ||
          !Array.isArray(event.message.openclawDisplayContent)
        ) {
          return [];
        }
        return event.message.openclawDisplayContent.filter(
          (block) => isRecord(block) && block.type === "attachment_error",
        );
      });
      expect(failureBlocks).toHaveLength(2);
      expect(
        failureBlocks.map((block) =>
          isRecord(block.attachment) ? block.attachment.label : undefined,
        ),
      ).toEqual(expect.arrayContaining(failures.map((failure) => failure.label)));
    });
  },
);
import fs from "node:fs/promises";
