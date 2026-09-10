import { SupervisedDecisionSchema, type SupervisedDecision } from "./supervised-task.types.js";

/** Only a failure at the decision parser warrants protocol-specific recovery.
 * Never promote arbitrary backend errors or model-authored strings to instructions. */
export class SupervisedDecisionFormatError extends SyntaxError {
  constructor(readonly detail: "invalid_json" | "invalid_shape" | "oversized") {
    super(`Invalid task decision (${detail}); expected one schema-valid JSON object within 64 KiB`);
    this.name = "SupervisedDecisionFormatError";
  }
}

export function parseSupervisedDecision(output: string): SupervisedDecision {
  if (Buffer.byteLength(output) > 64 * 1024) {
    throw new SupervisedDecisionFormatError("oversized");
  }
  // Retain the existing whole-response fence allowance. Never extract a JSON
  // substring from prose, or guess which of several objects is authoritative.
  const json = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SupervisedDecisionFormatError("invalid_json");
  }
  const parsed = SupervisedDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new SupervisedDecisionFormatError("invalid_shape");
  }
  return parsed.data;
}
