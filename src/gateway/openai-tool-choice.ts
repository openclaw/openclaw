/**
 * Shared OpenAI-compatible `tool_choice` constraint for Chat Completions and
 * Responses. The HTTP boundary uses this narrow shape so both endpoints enforce
 * caller-supplied client-tool requirements the same way.
 */
export type ToolChoiceConstraint = { type: "required" } | { type: "function"; name: string };

/**
 * Produces the system-prompt nudge paired with endpoint-level validation.
 * Providers may ignore the prompt, so callers must still validate the returned
 * structured client-tool calls before emitting a response.
 */
export function toolChoiceConstraintPrompt(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `You must call the ${constraint.name} tool before responding.`
    : "You must call one of the available tools before responding.";
}

/**
 * Returns true when no constraint is active, or when the agent produced a
 * structured tool call that honors it. `required` accepts any call; pinned
 * functions require a name match so callers can reject non-compliant turns.
 */
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

/**
 * Builds the shared OpenAI-compatible error text used after prompt steering and
 * tool narrowing fail to produce a matching structured client-tool call.
 */
export function resolveUnsatisfiedToolChoiceMessage(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `tool_choice required a ${constraint.name} tool call, but the agent did not produce one`
    : "tool_choice=required was not satisfied by the agent response";
}
