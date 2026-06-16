import type { Part } from "@google/genai";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { convertMessages } from "./google-shared.js";
import { makeGoogleAssistantMessage } from "./google-shared.test-helpers.js";

const convertMessagesForTest = convertMessages as unknown as (
  model: Model<"google-generative-ai">,
  context: Context,
) => ReturnType<typeof convertMessages>;

const makeVisionModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

function countFunctionResponses(parts: readonly Part[] | undefined): number {
  return (parts ?? []).filter((p) => p.functionResponse != null).length;
}

function countFunctionCalls(parts: readonly Part[] | undefined): number {
  return (parts ?? []).filter((p) => p.functionCall != null).length;
}

describe("google-shared convertMessages — parallel tool results with an image (Gemini < 3)", () => {
  it("keeps both parallel function responses in the user turn immediately after the model turn", () => {
    const model = makeVisionModel("gemini-2.5-flash");
    const context = {
      messages: [
        { role: "user", content: "Screenshot the page and check the weather." },
        makeGoogleAssistantMessage(model.id, [
          { type: "toolCall", id: "call_1", name: "screenshot", arguments: {} },
          { type: "toolCall", id: "call_2", name: "weather", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "screenshot",
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "weather",
          content: [{ type: "text", text: "Sunny, 21C" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);

    const modelTurn = contents[1];
    expect(modelTurn.role).toBe("model");
    expect(countFunctionCalls(modelTurn.parts)).toBe(2);

    const immediateUserTurn = contents[2];
    expect(immediateUserTurn.role).toBe("user");
    expect(countFunctionResponses(immediateUserTurn.parts)).toBe(2);

    const strandedAfterIndex2 = contents
      .slice(3)
      .some((c) => countFunctionResponses(c.parts) > 0);
    expect(strandedAfterIndex2).toBe(false);
  });
});
