import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { prepareToolSearchDispatcherArguments } from "../../agents/tool-search-request.js";
import type { Message } from "../../llm/types.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";

type DecisionInput = Parameters<typeof assertExperienceReviewDecision>[0];
const workshopId = "openclaw:core:skill_workshop";

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
          systemPrompt: "Available deferred-schema tools:\n- skill_workshop (core): Draft skills.",
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
      toolArguments: [],
      toolCalls: [],
      toolResults: [],
    },
  };
}

function workshopEnvelope(text: string, details: Record<string, unknown> = {}) {
  return {
    tool: { id: workshopId, name: "skill_workshop", source: "openclaw" },
    result: { content: [{ type: "text", text }], details },
  };
}

function addWorkshopCall(
  input: DecisionInput,
  id: string,
  args: Record<string, unknown>,
  text: string,
  details?: Record<string, unknown>,
) {
  const envelope = workshopEnvelope(text, details);
  input.observation.toolCalls.push({
    type: "toolCall",
    id,
    name: "tool_call",
    arguments: { id: envelope.tool.id, args },
  });
  input.observation.toolResults.push({
    ...makeTextToolResult(id, "tool_call", JSON.stringify(envelope), false, 0),
    details: envelope,
  });
  input.observation.toolArguments.push({
    toolCallId: id,
    prepared: { id: envelope.tool.id, args },
    validated: { id: envelope.tool.id, args },
  });
}

function setWorkshopCallArguments(
  input: DecisionInput,
  args: Record<string, unknown>,
  validated?: unknown,
) {
  input.observation.toolCalls[0]!.arguments = args;
  const prepared = prepareToolSearchDispatcherArguments(args);
  input.observation.toolArguments[0] = {
    toolCallId: input.observation.toolCalls[0]!.id,
    prepared,
    validated: validated ?? prepared,
  };
}

function proposal(): DecisionInput {
  const input = abstention();
  input.progress = { mutationCount: 1, proposalIds: ["proposal-1"] };
  input.proposals = [{ id: "proposal-1", status: "pending" }];
  input.outcome = { ...input.outcome!, outcome: "proposed", proposalId: "proposal-1" };
  addWorkshopCall(input, "create", { action: "create" }, "Created proposal-1", {
    id: "proposal-1",
    status: "pending",
  });
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
      const args = {
        action,
        skill_name: "existing-skill",
        ...(action === "prepare_patch" ? { old_string: "Existing skill" } : {}),
      };
      addWorkshopCall(input, "prepare", args, "Existing skill content");
      setWorkshopCallArguments(
        input,
        action === "read" ? { id: workshopId, ...args } : { id: workshopId, input: args },
      );
      expect(assertExperienceReviewDecision(input)).toBe("abstained");
    },
  );

  it.each(["tool_search", "tool_describe"])("allows successful %s before abstention", (name) => {
    const input = abstention();
    input.observation.toolCalls.push({ type: "toolCall", id: "discover", name, arguments: {} });
    input.observation.toolResults.push(makeTextToolResult("discover", name, "Workshop", false, 0));
    expect(assertExperienceReviewDecision(input)).toBe("abstained");
  });

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
      "missing Workshop directory entry",
      (input: DecisionInput) => {
        input.observation.requests[0]!.systemPrompt = "Review past work with skill_workshop.";
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
        addWorkshopCall(
          input,
          "read",
          { action: "create", name: "existing-skill" },
          "Existing skill content",
        );
      },
    ],
    [
      "rejected discovery",
      (input: DecisionInput) => {
        input.observation.toolCalls.push({
          type: "toolCall",
          id: "discover",
          name: "tool_search",
          arguments: {},
        });
        input.observation.toolResults.push(
          makeTextToolResult("discover", "tool_search", "discovery failed", true, 0),
        );
      },
    ],
    [
      "execution outside Workshop",
      (input: DecisionInput) => {
        input.observation.toolCalls.push({
          type: "toolCall",
          id: "read",
          name: "read",
          arguments: { path: "README.md" },
        });
        input.observation.toolResults.push(makeTextToolResult("read", "read", "content", false, 0));
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
  it.each([
    { label: "nested args", arguments: { id: workshopId, args: { action: "create" } } },
    { label: "input wrapper", arguments: { id: workshopId, input: { action: "create" } } },
    {
      label: "flattened proposal name",
      arguments: { id: workshopId, action: "create", name: "queue-audit" },
    },
    {
      label: "empty wrapper with flattened arguments",
      arguments: { id: workshopId, args: {}, action: "create", name: "queue-audit" },
    },
    {
      label: "dotted arguments",
      arguments: { id: workshopId, "args.action": "create", "args.name": "queue-audit" },
    },
    {
      label: "double-wrapped selector alias",
      arguments: { args: { toolId: workshopId, args: { action: "create" } } },
    },
    {
      label: "trimmed selector",
      arguments: { id: " skill_workshop ", args: { action: "create" } },
    },
    {
      label: "JSON-encoded args",
      arguments: { id: workshopId, args: JSON.stringify({ action: "create" }) },
      validated: { id: workshopId, args: { action: "create" } },
    },
  ])(
    "accepts $label with one pending proposal and its matching receipt",
    ({ arguments: args, validated }) => {
      const input = proposal();
      setWorkshopCallArguments(input, args, validated);
      expect(assertExperienceReviewDecision(input)).toBe("proposed");
    },
  );
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
      "arguments changed after validation",
      (input: DecisionInput) => {
        input.observation.toolCalls[0]!.arguments.id = "openclaw:core:exec";
      },
    ],
    [
      "failed inner target receipt",
      (input: DecisionInput) => {
        const envelope = workshopEnvelope("Created proposal-1", {
          id: "proposal-1",
          status: "pending",
        });
        const failedEnvelope = {
          ...envelope,
          result: { ...envelope.result, isError: true },
        };
        input.observation.toolResults[0]!.content = [
          { type: "text", text: JSON.stringify(failedEnvelope) },
        ];
        input.observation.toolResults[0]!.details = failedEnvelope;
      },
    ],
    [
      "extra mutation",
      (input: DecisionInput) => {
        input.progress.mutationCount = 2;
      },
    ],
    [
      "missing target receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.details = undefined;
      },
    ],
    [
      "mismatched target",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.details = {
          tool: { id: "openclaw:core:exec", name: "exec", source: "openclaw" },
          result: { content: [{ type: "text", text: "Created proposal-1" }] },
        };
      },
    ],
    [
      "mismatched target selector",
      (input: DecisionInput) => {
        setWorkshopCallArguments(input, { id: "exec", args: { action: "create" } });
      },
    ],
    [
      "unknown selector beside a known alias",
      (input: DecisionInput) => {
        setWorkshopCallArguments(input, {
          id: "unknown-target-id",
          toolId: workshopId,
          action: "create",
        });
      },
    ],
    [
      "missing argument validation",
      (input: DecisionInput) => {
        input.observation.toolArguments = [];
      },
    ],
    [
      "missing target result details",
      (input: DecisionInput) => {
        const envelope = workshopEnvelope("Created proposal-1");
        input.observation.toolResults[0]!.details = {
          tool: envelope.tool,
          result: { content: envelope.result.content },
        };
      },
    ],
    [
      "missing target result content",
      (input: DecisionInput) => {
        const envelope = workshopEnvelope("", { id: "proposal-1", status: "pending" });
        envelope.result.content = [];
        input.observation.toolResults[0]!.details = envelope;
      },
    ],
    [
      "mismatched target proposal",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.details = workshopEnvelope("Created proposal-1", {
          id: "different-proposal",
          status: "pending",
        });
      },
    ],
    [
      "failed target result under a successful wrapper",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.details = workshopEnvelope("Created proposal-1", {
          id: "proposal-1",
          status: "failed",
        });
      },
    ],
  ] as const)("rejects %s even when one proposal ID is reported", (_label, corrupt) => {
    const input = proposal();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
});
