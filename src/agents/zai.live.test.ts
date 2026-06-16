// Z.ai live tests verify GLM completions against the real provider when live
// credentials and live-test flags are enabled.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";

const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["ZAI_LIVE_TEST"]);
const CODING_LIVE = isTruthyEnvValue(process.env.ZAI_CODING_LIVE_TEST);
const ZAI_LIVE_TIMEOUT_MS = 45_000;
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

const describeLive = LIVE && !CODING_LIVE && ZAI_KEY ? describe : describe.skip;
const describeCodingLive = CODING_LIVE && ZAI_KEY ? describe : describe.skip;

async function expectModelReturnsAssistantText(
  modelId: "glm-5.2" | "glm-5-turbo" | "glm-5.1",
  baseUrl = ZAI_GLOBAL_BASE_URL,
) {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "zai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelId === "glm-5.2" ? 1_000_000 : 202_800,
    maxTokens: modelId === "glm-5.2" ? 131_072 : 131_100,
  };
  const res = await completeSimple(
    model,
    {
      messages: createSingleUserPromptMessage(),
    },
    { apiKey: ZAI_KEY, maxTokens: 64 },
  );
  const text = extractNonEmptyAssistantText(res.content);
  expect(text.length).toBeGreaterThan(0);
}

describeCodingLive("zai Coding Plan live", () => {
  it(
    "glm-5.2 returns assistant text through the Coding Plan endpoint",
    async () => {
      await expectModelReturnsAssistantText("glm-5.2", ZAI_CODING_GLOBAL_BASE_URL);
    },
    ZAI_LIVE_TIMEOUT_MS,
  );
});

describeLive("zai live", () => {
  it(
    "returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-5-turbo");
    },
    ZAI_LIVE_TIMEOUT_MS,
  );

  it(
    "glm-5.1 returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-5.1");
    },
    ZAI_LIVE_TIMEOUT_MS,
  );
});
