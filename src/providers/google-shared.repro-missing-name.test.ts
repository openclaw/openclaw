import type { Context, Model } from "@mariozechner/pi-ai/dist/types.js";
import { convertMessages } from "@mariozechner/pi-ai/dist/providers/google-shared.js";
import { describe, expect, it } from "vitest";

const makeGeminiCliModel = (id: string): Model<"google-gemini-cli"> =>
  ({
    id,
    name: id,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-gemini-cli">;

describe("google-shared REQUIRED_FIELD_MISSING repro", () => {
  it("shows that toolResult without toolName leads to missing name in functionResponse", () => {
    const model = makeGeminiCliModel("gemini-3-flash");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "myTool",
              arguments: { arg: "value" },
            },
          ],
          api: "google-gemini-cli",
          provider: "google-gemini-cli",
          model: "gemini-3-flash",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          // toolName: "myTool", // MISSING!
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const parts = contents.flatMap((content) => content.parts ?? []);
    const toolResponsePart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    ) as any;

    expect(toolResponsePart).toBeTruthy();
    // This is the bug: if toolName is missing, name becomes undefined
    // which Gemini API rejects with REQUIRED_FIELD_MISSING
    expect(toolResponsePart.functionResponse.name).toBeUndefined();
  });
});
