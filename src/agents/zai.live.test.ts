import { complete, completeSimple, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";

const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
const LIVE = isTruthyEnvValue(process.env.ZAI_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && ZAI_KEY ? describe : describe.skip;

type ZaiLiveModelId = "glm-5" | "glm-4.7" | "glm-4.7-flashx";

async function expectModelReturnsAssistantText(modelId: ZaiLiveModelId) {
  const model = getModel("zai", modelId as "glm-5");
  if (!model) {
    throw new Error(`Model not available in catalog: zai/${modelId}`);
  }
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

async function expectModelReturnsToolCall(modelId: "glm-5") {
  const model = getModel("zai", modelId as "glm-5");
  if (!model) {
    throw new Error(`Model not available in catalog: zai/${modelId}`);
  }
  const res = await complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: "Call the ping tool with {} and do not add extra text.",
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "ping",
          description: "Return pong",
          parameters: Type.Object({}),
        },
      ],
    },
    { apiKey: ZAI_KEY, maxTokens: 64, temperature: 0, toolChoice: "required" },
  );
  const hasToolCall = res.content.some((block) => block.type === "toolCall");
  expect(hasToolCall).toBe(true);
}

function hasZaiModel(modelId: ZaiLiveModelId): boolean {
  try {
    return Boolean(getModel("zai", modelId as "glm-5"));
  } catch {
    return false;
  }
}

describeLive("zai live", () => {
  it.skipIf(!hasZaiModel("glm-5"))(
    "glm-5 returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-5");
    },
    20000,
  );

  it.skipIf(!hasZaiModel("glm-4.7"))(
    "glm-4.7 returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-4.7");
    },
    20000,
  );

  it.skipIf(!hasZaiModel("glm-5"))(
    "glm-5 returns tool call",
    async () => {
      await expectModelReturnsToolCall("glm-5");
    },
    30000,
  );

  it.skipIf(!hasZaiModel("glm-4.7-flashx"))(
    "glm-4.7-flashx returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-4.7-flashx");
    },
    20000,
  );
});
