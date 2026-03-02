import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";

const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
const LIVE = isTruthyEnvValue(process.env.ZAI_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && ZAI_KEY ? describe : describe.skip;

async function expectModelReturnsAssistantText(modelId: "glm-4.7" | "glm-4.7-flashx") {
  const model = getModel("zai", modelId as "glm-4.7");
  const res = await completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: "Reply with the word ok.",
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: ZAI_KEY, maxTokens: 64 },
  );
  const text = res.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .join(" ");
  expect(text.length).toBeGreaterThan(0);
}

describeLive("zai live", () => {
  it("returns assistant text", async () => {
    await expectModelReturnsAssistantText("glm-4.7");
  }, 20000);

  it("glm-4.7-flashx returns assistant text", async () => {
    await expectModelReturnsAssistantText("glm-4.7-flashx");
  }, 20000);
});
