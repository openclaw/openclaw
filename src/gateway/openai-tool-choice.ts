// Providers cannot all force tool calls, so both compatibility endpoints constrain
// exposed tools and reject responses that lack the required structured call.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import type { CreateResponseBody } from "./open-responses.schema.js";

export type ToolChoiceConstraint = { type: "required" } | { type: "function"; name: string };

export function resolveChatToolChoice(
  toolChoice: unknown,
): ToolChoiceConstraint | "none" | undefined {
  if (toolChoice == null || toolChoice === "auto") {
    return undefined;
  }
  if (toolChoice === "none") {
    return "none";
  }
  if (toolChoice === "required") {
    return { type: "required" };
  }
  const choice = asOptionalRecord(toolChoice);
  if (!choice) {
    throw new Error("tool_choice must be a string or object");
  }
  const choiceType = choice.type;
  if (choiceType === "function") {
    const targetName = normalizeOptionalString(asOptionalRecord(choice.function)?.name);
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    return { type: "function", name: targetName };
  }
  if (typeof choiceType !== "string") {
    throw new Error("unsupported tool_choice type");
  }
  throw new Error(`tool_choice ${choiceType} is not supported`);
}

export function resolveResponsesToolChoice(
  toolChoice: CreateResponseBody["tool_choice"],
): ToolChoiceConstraint | "none" | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "none") {
    return "none";
  }

  if (toolChoice === "required") {
    return { type: "required" };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = ("name" in toolChoice ? toolChoice.name : toolChoice.function.name).trim();
    if (!targetName) {
      throw new Error("tool_choice.name is required");
    }
    return { type: "function", name: targetName };
  }

  return undefined;
}

export function applyToolChoice(
  tools: ClientToolDefinition[],
  choice: ToolChoiceConstraint | "none" | undefined,
): {
  tools: ClientToolDefinition[];
  extraSystemPrompt?: string;
  constraint?: ToolChoiceConstraint;
} {
  if (!choice) {
    return { tools };
  }
  if (choice === "none") {
    return { tools: [] };
  }
  const selectedTools =
    choice.type === "function" ? tools.filter((tool) => tool.function.name === choice.name) : tools;
  if (selectedTools.length === 0) {
    throw new Error(
      choice.type === "function"
        ? `tool_choice requested unknown tool: ${choice.name}`
        : "tool_choice=required but no tools were provided",
    );
  }
  return {
    tools: selectedTools,
    extraSystemPrompt:
      choice.type === "function"
        ? `You must call the ${choice.name} tool before responding.`
        : "You must call one of the available tools before responding.",
    constraint: choice,
  };
}

export function isToolChoiceConstraintSatisfied(params: {
  constraint: ToolChoiceConstraint | undefined;
  pendingToolCalls: ReadonlyArray<{ name: string }> | undefined;
}): boolean {
  const { constraint, pendingToolCalls } = params;
  if (!constraint) {
    return true;
  }
  return Boolean(
    pendingToolCalls?.length &&
    (constraint.type === "required" ||
      pendingToolCalls.some((call) => call.name === constraint.name)),
  );
}

export function resolveUnsatisfiedToolChoiceMessage(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `tool_choice required a ${constraint.name} tool call, but the agent did not produce one`
    : "tool_choice=required was not satisfied by the agent response";
}
