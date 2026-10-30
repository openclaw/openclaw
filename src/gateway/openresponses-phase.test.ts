/**
 * Tests OpenAI Responses phase tracking for gateway request processing.
 */
import { describe, expect, it } from "vitest";
import { CreateResponseBodySchema } from "./open-responses.schema.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";

describe("openresponses phase support", () => {
  it("accepts assistant message phase and rejects user phase", () => {
    const assistantPhaseRequest = CreateResponseBodySchema.safeParse({
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: "Checking logs before I answer.",
        },
        {
          type: "message",
          role: "user",
          content: "What did you find?",
        },
      ],
    });
    expect(assistantPhaseRequest.success).toBe(true);

    const userPhaseRequest = CreateResponseBodySchema.safeParse({
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "user",
          phase: "commentary",
          content: "Hi",
        },
      ],
    });
    expect(userPhaseRequest.success).toBe(false);
  });

  it("builds prompts from phased assistant history without dropping text", () => {
    const prompt = buildAgentPrompt([
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: "Checking logs before I answer.",
      },
      {
        type: "message",
        role: "user",
        content: "What did you find?",
      },
    ]);

    expect(prompt.message).toContain("Checking logs before I answer.");
    expect(prompt.message).toContain("What did you find?");
  });
});
