import { expect, it } from "vitest";
import { isCompactionSummaryRequest } from "./compaction-summary-request.js";

it("recognizes cold summaries", () => {
  expect(
    isCompactionSummaryRequest(
      JSON.stringify({ instructions: "You are a context summarization assistant." }),
    ),
  ).toBe(true);
});

it.each([
  "The messages above are a conversation to summarize.",
  "The messages above are NEW conversation messages to incorporate into the existing summary.",
  "Produce a compact, factual summary with these exact section headings:\n## Decisions",
])("recognizes warm summary instruction: %s", (instruction) => {
  for (const body of [
    { input: [{ role: "user", content: [{ type: "input_text", text: instruction }] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: instruction }] }] },
    { messages: [{ role: "user", content: instruction }] },
  ]) {
    expect(isCompactionSummaryRequest(JSON.stringify(body))).toBe(true);
  }
});

it("does not treat earlier summary instructions as a new summary request", () => {
  expect(
    isCompactionSummaryRequest(
      JSON.stringify({
        input: [
          { role: "user", content: "The messages above are a conversation to summarize." },
          { role: "assistant", content: "Summary." },
          { role: "user", content: "Continue the scheduled task." },
        ],
      }),
    ),
  ).toBe(false);
});
