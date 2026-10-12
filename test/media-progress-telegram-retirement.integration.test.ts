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

const planStep = "Draw the wedding portrait";

it.each<{ label: string; outcomes: ("delivered" | "failed")[]; maxLines?: number; plan?: true }>([
  { label: "a delivered image", outcomes: ["delivered"] },
  { label: "a failed image", outcomes: ["failed"] },
  { label: "a delivered then a failed image", outcomes: ["delivered", "failed"] },
  { label: "a failed then a delivered image", outcomes: ["failed", "delivered"] },
  // Bounded cards keep the failure ahead of later rows and the turn's plan.
  {
    label: "a failed then a delivered image on a one-line card",
    outcomes: ["failed", "delivered"],
    maxLines: 1,
  },
  {
    label: "a failed image on a one-line card with a plan",
    outcomes: ["failed"],
    maxLines: 1,
    plan: true,
  },
])("keeps the quiet card until $label settles", async ({ outcomes, maxLines, plan }) => {
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
      if (plan) {
        await options?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: planStep, status: "in_progress" }],
        });
      }
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
    .toContain(plan ? planStep : "Image generation: running");

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
  if (outcomes.includes("delivered") && !maxLines) {
    expect(card).toContain("Image generation: completed");
  }
});
