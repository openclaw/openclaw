import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import type { Message } from "../../llm/types.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";

type DecisionInput = Parameters<typeof assertExperienceReviewDecision>[0];
function abstention(): DecisionInput {
  const messages: Message[] = [
    makeTextToolResult("history", "exec", "observed recovery", false, 0),
  ];
  return {
    messages,
    startedAt: 1,
    progress: { mutationCount: 0, proposalIds: [] },
    proposals: [],
    outcome: {
      attemptedAtMs: 1,
      outcome: "nothing",
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 8 },
    },
    observation: {
      requests: [
        {
          toolNames: ["exec", "read", "tool_search", "tool_describe", "tool_call"],
          outputs: messages
            .filter((message) => message.role === "toolResult")
            .map((message) =>
              message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            ),
        },
      ],
      finalText: "NO_REPLY",
      toolCalls: [],
      toolResults: [],
    },
  };
}

function appendWorkshopCall(
  input: DecisionInput,
  id: string,
  args: Record<string, unknown>,
  text: string,
) {
  const tool = { id: "openclaw:core:skill_workshop", name: "skill_workshop", source: "openclaw" };
  input.observation.toolCalls.push({
    type: "toolCall",
    id,
    name: "tool_call",
    arguments: { id: tool.id, args },
  });
  input.observation.toolResults.push(
    makeTextToolResult(
      id,
      "tool_call",
      JSON.stringify({ tool, result: { content: [{ type: "text", text }] } }),
      false,
      0,
    ),
  );
}

function proposal(): DecisionInput {
  const input = abstention();
  input.progress = { mutationCount: 1, proposalIds: ["proposal-1"] };
  input.proposals = [{ id: "proposal-1", status: "pending" }];
  input.outcome = { ...input.outcome!, outcome: "proposed", proposalId: "proposal-1" };
  appendWorkshopCall(input, "create", { action: "create" }, "Created proposal-1");
  return input;
}

describe("Workshop live decision acceptance", () => {
  it("requires explicit abstention with intact evidence and a fresh recorded outcome", () => {
    expect(assertExperienceReviewDecision(abstention())).toBe("abstained");
  });

  it.each(["read", "prepare_patch"])(
    "allows successful %s before explicit abstention",
    (action) => {
      const input = abstention();
      appendWorkshopCall(
        input,
        "prepare",
        { action, name: "existing-skill" },
        "Existing skill content",
      );
      expect(assertExperienceReviewDecision(input)).toBe("abstained");
    },
  );

  it.each([
    [
      "empty completion",
      (input: DecisionInput) => {
        input.observation.finalText = "";
      },
    ],
    [
      "generic completion",
      (input: DecisionInput) => {
        input.observation.finalText = "There is nothing useful to add.";
      },
    ],
    [
      "lost replay result",
      (input: DecisionInput) => {
        input.observation.requests[0]!.outputs.pop();
      },
    ],
    [
      "missing discovery controls",
      (input: DecisionInput) => {
        input.observation.requests[0]!.toolNames = ["exec", "read"];
      },
    ],
    [
      "stale recorded outcome",
      (input: DecisionInput) => {
        input.outcome!.attemptedAtMs = 0;
      },
    ],
    [
      "missing outcome",
      (input: DecisionInput) => {
        input.outcome = undefined;
      },
    ],
    [
      "mutation attempt before abstention",
      (input: DecisionInput) => {
        appendWorkshopCall(
          input,
          "read",
          { action: "create", name: "existing-skill" },
          "Existing skill content",
        );
      },
    ],
    [
      "rejected tool",
      (input: DecisionInput) => {
        input.observation.toolResults.push(
          makeTextToolResult("rejected", "tool_call", "name required", true, 0),
        );
      },
    ],
  ] as const)("rejects %s even when the proposal count is zero", (_label, corrupt) => {
    const input = abstention();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
  it("accepts one pending proposal backed by a matching successful tool receipt", () => {
    expect(assertExperienceReviewDecision(proposal())).toBe("proposed");
  });
  it.each([
    [
      "missing mutation call",
      (input: DecisionInput) => {
        input.observation.toolCalls = [];
      },
    ],
    [
      "missing proposal record",
      (input: DecisionInput) => {
        input.proposals = [];
      },
    ],
    [
      "wrong tool receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.toolCallId = "unrelated";
      },
    ],
    [
      "wrong dispatched target",
      (input: DecisionInput) => {
        input.observation.toolCalls[0]!.arguments.id = "openclaw:core:exec";
      },
    ],
    [
      "failed inner target receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.content = [
          {
            type: "text",
            text: JSON.stringify({
              tool: {
                id: "openclaw:core:skill_workshop",
                name: "skill_workshop",
                source: "openclaw",
              },
              result: { isError: true, content: [{ type: "text", text: "Created proposal-1" }] },
            }),
          },
        ];
      },
    ],
    [
      "extra mutation",
      (input: DecisionInput) => {
        input.progress.mutationCount = 2;
      },
    ],
  ] as const)("rejects %s even when one proposal ID is reported", (_label, corrupt) => {
    const input = proposal();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
});
