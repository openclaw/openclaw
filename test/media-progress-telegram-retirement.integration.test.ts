import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { loadTelegramDispatchHttpFixture } from "../extensions/telegram/test-api.js";
import { adoptMediaGenerationProgressDraft } from "../src/agents/media-generation-activity.js";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../src/agents/media-generation-activity.test-support.js";
import { createMediaGenerationTaskLifecycle } from "../src/agents/tools/media-generate-background-shared.js";
import { projectAgentToolActivity } from "../src/infra/agent-activity-events.js";

// Root-owned integration: the media activity owner settles the card Telegram retained.
const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const sessionKey = "agent:main:telegram:group:-100";
const waitingText = "Waiting for the image.";

it.each<[string, ("delivered" | "failed")[], number | undefined]>([
  ["a delivered image", ["delivered"], undefined],
  ["a failed image", ["failed"], undefined],
  ["a delivered then a failed image", ["delivered", "failed"], undefined],
  ["a failed then a delivered image", ["failed", "delivered"], undefined],
  ["a failed then a delivered image on a one-line card", ["failed", "delivered"], 1],
])("keeps the quiet card until %s settles", async (_label, outcomes, maxLines) => {
  onTestFinished(resetGeneratedMediaTaskActivityForTests);
  const runs = outcomes.map((outcome, index) => ({
    outcome,
    handle: admitMediaHandle({
      taskId: `image-${index}`,
      runId: `tool:image_generate:${index}`,
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      taskLabel: "wedding portrait",
    }),
  }));
  let adopted = false;
  await http.dispatchProgressTurn(
    async (options) => {
      await http.emitToolStart(options, { name: "exec", phase: "start", toolCallId: "generate" });
      await http.waitForBotApiCall((call) => call.method === "sendMessage");
      // The wrapper ends once the detached media run has started.
      await options?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "generate",
          name: "exec",
          phase: "result",
          isError: false,
        }),
      );
    },
    {
      mode: "progress",
      toolProgress: false,
      telegramCfg: maxLines
        ? { streaming: { mode: "progress", progress: { toolProgress: false, maxLines } } }
        : undefined,
      finalReply: setReplyPayloadMetadata(
        { text: waitingText },
        {
          progressContinuation: {
            adopt: (draft) =>
              (adopted = adoptMediaGenerationProgressDraft(sessionKey, "main", draft)),
            close: () => undefined,
          },
        },
      ),
    },
  );
  expect(adopted).toBe(true);
  const [cardId, ...others] = [...http.visibleMessages.keys()];
  assert(cardId !== undefined);
  expect(others).toEqual([]);
  await expect
    .poll(() => http.visibleMessages.get(cardId), { timeout: 5_000 })
    .toContain("Image generation: running");

  const lifecycle = createMediaGenerationTaskLifecycle("image");
  for (const { outcome, handle } of runs) {
    if (outcome === "delivered") {
      lifecycle.completeTaskRun({ handle, provider: "fixture", model: "fixture", count: 1 });
    } else {
      lifecycle.failTaskRun({ handle, error: new Error("provider failed") });
    }
  }
  await vi.advanceTimersByTimeAsync(2_000);
  if (!outcomes.includes("failed")) {
    await expect.poll(() => http.visibleMessages.has(cardId), { timeout: 5_000 }).toBe(false);
    return;
  }
  // An undelivered result leaves the card as the chat's visible outcome.
  await expect
    .poll(() => http.visibleMessages.get(cardId), { timeout: 5_000 })
    .toContain("Image generation: failed");
  const card = http.visibleMessages.get(cardId);
  expect(card).not.toContain("running");
  // The delivered image is in the chat; only the failed run stays on the card.
  expect(card).not.toContain("completed");
});
