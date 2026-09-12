import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";

const PLAN_PROGRESS_TOOL_NAMES = new Set(["progress_card", "update_plan"]);

export function isAgentPlanProgressToolName(name: string | undefined): boolean {
  return PLAN_PROGRESS_TOOL_NAMES.has(name?.trim().toLowerCase() ?? "");
}

/** Projects checklist counts or readable notes through the shared Markdown owner. */
export function projectProgressCardChannelUpdate(input: unknown) {
  const record = asOptionalRecord(input);
  if (!record) {
    return undefined;
  }
  try {
    const normalized = normalizeProgressCardInput(record);
    const steps = normalized.steps ?? [];
    const completed = steps.filter((step) => step.status === "completed").length;
    const explanation = steps.length
      ? `${completed}/${steps.length} complete`
      : normalized.markdown
        ? stripMarkdown(normalized.markdown, { linkStyle: "label", stripHtml: true })
            .replace(/\s+/g, " ")
            .trim() || "Progress updated"
        : undefined;
    return { steps, ...(explanation ? { explanation } : {}) };
  } catch (error) {
    if (error instanceof ProgressCardInputError) {
      return undefined;
    }
    throw error;
  }
}
