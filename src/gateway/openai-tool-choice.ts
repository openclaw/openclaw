/** Shared OpenAI-compatible tool_choice constraint used by chat and responses routes. */
export type ToolChoiceConstraint = { type: "required" } | { type: "function"; name: string };

/** Builds the prompt nudge paired with HTTP-side post-run tool_choice validation. */
export function toolChoiceConstraintPrompt(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `You must call the ${constraint.name} tool before responding.`
    : "You must call one of the available tools before responding.";
}

/** Checks whether the agent emitted the structured tool call required by tool_choice. */
export function isToolChoiceConstraintSatisfied(params: {
  constraint: ToolChoiceConstraint | undefined;
  pendingToolCalls: ReadonlyArray<{ name: string }> | undefined;
}): boolean {
  const { constraint, pendingToolCalls } = params;
  if (!constraint) {
    return true;
  }
  if (!pendingToolCalls || pendingToolCalls.length === 0) {
    return false;
  }
  if (constraint.type === "required") {
    return true;
  }
  return pendingToolCalls.some((call) => call.name === constraint.name);
}

/** Returns the OpenAI-compatible error detail for an unsatisfied tool_choice constraint. */
export function resolveUnsatisfiedToolChoiceMessage(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `tool_choice required a ${constraint.name} tool call, but the agent did not produce one`
    : "tool_choice=required was not satisfied by the agent response";
}
