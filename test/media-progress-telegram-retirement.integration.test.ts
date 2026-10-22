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

const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const sessionKey = "agent:main:telegram:group:-100";
const planStep = "Draw the wedding portrait";
const tool = { name: "exec", toolCallId: "generate" };

it.each<{ outcomes: ("delivered" | "failed")[]; maxLines?: number; plan?: true }>([
  { outcomes: ["delivered"] },
  { outcomes: ["failed"] },
  { outcomes: ["delivered", "failed"] },
  { outcomes: ["failed", "delivered"] },
  { outcomes: ["failed", "delivered"], maxLines: 1 },
  { outcomes: ["failed"], maxLines: 1, plan: true },
])("retires the quiet card after settlement: %j", async ({ outcomes, maxLines, plan }) => {
  onTestFinished(resetGeneratedMediaTaskActivityForTests);
  const lifecycle = createMediaGenerationTaskLifecycle("image");
  const settlements = outcomes.map((outcome, index) => {
    const handle = admitMediaHandle({
      taskId: `image-${index}`,
      runId: `tool:image_generate:${index}`,
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      taskLabel: "wedding portrait",
    });
    return () =>
      outcome === "delivered"
        ? lifecycle.completeTaskRun({ handle, count: 1 })
        : lifecycle.failTaskRun({ handle });
  });
  let adopted = false;
  await http.dispatchProgressTurn(
    async (options) => {
      if (plan) {
        await options?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: planStep, status: "in_progress" }],
        });
      }
      await http.emitToolStart(options, { ...tool, phase: "start" });
      await http.waitForBotApiCall((call) => call.method === "sendMessage");
      // The wrapper ends once the detached media run has started.
      await options?.onItemEvent?.(
        projectAgentToolActivity({ ...tool, phase: "result", isError: false }),
      );
    },
    {
      mode: "progress",
      toolProgress: false,
      telegramCfg: maxLines
        ? { streaming: { mode: "progress", progress: { toolProgress: false, maxLines } } }
        : undefined,
      finalReply: setReplyPayloadMetadata(
        { text: "Waiting for the image." },
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
  const pollCard = () => expect.poll(() => http.visibleMessages.get(cardId), { timeout: 5_000 });
  await pollCard().toContain(plan ? planStep : "Image generation: running");
  for (const settle of settlements) {
    settle();
  }
  await vi.advanceTimersByTimeAsync(2_000);
  if (!outcomes.includes("failed")) {
    await expect.poll(() => http.visibleMessages.has(cardId), { timeout: 5_000 }).toBe(false);
    return;
  }
  // An undelivered result leaves the card as the chat's visible outcome.
  await pollCard().toContain("Image generation: failed");
  const card = http.visibleMessages.get(cardId);
  expect(card).not.toContain("running");
  if (outcomes.includes("delivered") && !maxLines) {
    expect(card).toContain("Image generation: completed");
  }
});
