export type InteractionMode = "chat" | "plan";

export function normalizeInteractionMode(value: unknown): InteractionMode {
  return value === "plan" ? "plan" : "chat";
}

export function buildPlanModePrompt(): string {
  return [
    "## Plan Mode",
    "You are in planning mode for this run.",
    "Your job is to investigate, clarify, and produce a plan, not to execute the work.",
    "Do not make repository edits, run mutating tools, or carry out the implementation.",
    "Use request_user_input when a material product or implementation decision must be chosen.",
    "Prefer structured questions over open-ended questions when reasonable.",
    "When the spec is decision-complete, output exactly one <proposed_plan>...</proposed_plan> block.",
    "Outside that final block, use normal chat for intermediate discussion and questions.",
  ].join("\n");
}
