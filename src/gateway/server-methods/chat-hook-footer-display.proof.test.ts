import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  publishTranscriptUpdate,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import * as hookRunnerGlobal from "../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAssistantDisplayRewrite } from "./chat-transcript-persistence.js";

// #206571: a `before_message_write` hook that appends a footer to a final reply must
// keep that footer in `openclawDisplayContent` for media replies, exactly once.
//
// This drives the real hook runner (`runAgentHarnessBeforeMessageWriteHook` with a
// registered `before_message_write` handler), the real transcript persistence owner, and
// the real display projection (`projectChatDisplayMessages`) that the Control UI /
// WebChat history path uses. Only the model transport is not exercised.

const lifetime = createFixtureLifetime();
afterAll(() => lifetime.close?.());

const RUN_ID = "hook-footer-run";
const FOOTER = "FOOTER_FROM_HOOK";
const MEDIA = "https://media.example.test/generated.png";

type Scenario = { withMedia: boolean };

function assistantContent(withMedia: boolean) {
  const caption = withMedia ? `Caption text.\n\nMEDIA:${MEDIA}` : "Caption text only.";
  return [{ type: "text" as const, text: caption }];
}

async function runScenario(scenario: Scenario): Promise<string[]> {
  return await withOpenClawTestState({ label: "hook-footer-media" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionId: "hook-footer-session",
      sessionKey: "agent:main:hook-footer",
      env: state.env,
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    // Real hook runner: a plugin `before_message_write` handler appends the footer to
    // assistant messages that carry a MEDIA directive.
    const hookSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
      createHookRunnerWithRegistry([
        {
          hookName: "before_message_write",
          handler: (event: unknown) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            if (message?.role !== "assistant" || !Array.isArray(message.content)) {
              return;
            }
            const blocks = message.content.map((block) => asOptionalRecord(block));
            const hasMedia = blocks.some(
              (block) =>
                block?.type === "text" &&
                typeof block.text === "string" &&
                /MEDIA:/u.test(block.text),
            );
            if (!hasMedia) {
              return;
            }
            // Append the footer to the media-bearing text block, matching the reported
            // shape: `Caption.\n\nMEDIA:...\n\nFOOTER`.
            return {
              message: {
                ...message,
                content: message.content.map((block) => {
                  const record = asOptionalRecord(block);
                  if (
                    record?.type === "text" &&
                    typeof record.text === "string" &&
                    /MEDIA:/u.test(record.text)
                  ) {
                    return { ...record, text: `${record.text}\n\n${FOOTER}` };
                  }
                  return block;
                }),
              },
            };
          },
        },
      ]).runner,
    );

    try {
      // Persist the assistant row through the real hook + persistence path.
      const message = runAgentHarnessBeforeMessageWriteHook({
        message: attachSessionTranscriptRunId(
          buildAssistantMessage({
            model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
            content: assistantContent(scenario.withMedia),
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
          RUN_ID,
        ),
      });
      if (message?.role !== "assistant") {
        throw new Error("expected prepared assistant message");
      }
      appendTranscriptMessageSync(scope, { eventId: "footer-row", message });
      await publishTranscriptUpdate(scope, {
        message,
        messageId: "footer-row",
        runId: RUN_ID,
      });

      // Read back the persisted, hook-finalized row.
      const entry = expectDefined(
        loadTranscriptEventsSync(scope)
          .map(asOptionalRecord)
          .find((candidate) => candidate?.id === "footer-row"),
        "persisted assistant row",
      );
      const persisted = asOptionalRecord(entry?.message) ?? {};
      const image = { type: "image", url: "/api/chat/media/outgoing/hook/full" };
      // The delivery payload is the pre-hook caption (what the channel delivered),
      // exactly as WebChat finalization passes it. The persisted message already carries
      // the hook-added footer, which is the input `buildAssistantDisplayRewrite` reads.
      const rewrite = buildAssistantDisplayRewrite({
        message: persisted,
        displayContent: scenario.withMedia
          ? [{ type: "text", text: "Caption text." }, image]
          : [{ type: "text", text: "Caption text only." }],
        mediaBySource: scenario.withMedia
          ? new Map([[normalizeMediaReferenceForComparison(MEDIA), [image]]])
          : undefined,
        managedMediaUrls: scenario.withMedia ? [MEDIA] : undefined,
      });
      const display = rewrite.openclawDisplayContent;
      if (!Array.isArray(display)) {
        return [];
      }
      return display
        .map((block) => asOptionalRecord(block))
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => String(block.text).trim())
        .filter(Boolean);
    } finally {
      hookSpy.mockRestore();
    }
  });
}

it("keeps the hook-added footer once on a media reply", async () => {
  const texts = await runScenario({ withMedia: true });
  // Footer present exactly once, caption not duplicated.
  expect(texts.filter((text) => text === FOOTER)).toHaveLength(1);
  expect(texts.filter((text) => text === "Caption text.")).toHaveLength(1);
});

it("does not add the footer to a text-only reply (control)", async () => {
  const texts = await runScenario({ withMedia: false });
  expect(texts.filter((text) => text === FOOTER)).toHaveLength(0);
  expect(texts.some((text) => text.includes("Caption text only."))).toBe(true);
});
