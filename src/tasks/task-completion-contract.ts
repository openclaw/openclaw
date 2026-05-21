import type { TaskTerminalOutcome } from "./task-registry.types.js";

export type RequiredCompletionTerminalResult = {
  terminalOutcome?: Extract<TaskTerminalOutcome, "blocked">;
  terminalSummary?: string;
};

const FINAL_DELIVERABLE_INDICATOR_PATTERN =
  /\b(?:added|already|changed|completed|created|diagnosis|done|failed|finished|fixed|found|implemented|merged|no changes|nothing to change|opened|passed|ready|report|result|results|summary|tested|updated|validated|verified|wrote)\b/i;

const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'|’)ll|i will|i(?:'|’)m|i am|i(?:'|’)m going to|i am going to|let me|i need to)\s+(?:now\s+)?(?:analyz(?:e|ing)|apply|check(?:ing)?|continue|debug(?:ging)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?(?:\s+into)?|map(?:ping)?|open(?:ing)?|read(?:ing)?|review(?:ing)?|run(?:ning)?|start(?:ing)?|test(?:ing)?|trace|trac(?:e|ing)|try(?:ing)?|update|verify(?:ing)?|work(?:ing)?)/i;

const BARE_PROGRESS_ONLY_PATTERN =
  /^(?:analyz(?:e|ing)|checking|debugging|inspecting|investigating|looking\s+into|mapping|reading|reviewing|running|testing|tracing|verifying|working\s+on)\b/i;

function normalizeCompletionText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeCompletionFailureReason(value: string | null | undefined): string {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return "";
  }
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}...`;
}

export function isProgressOnlyCompletionText(value: string | null | undefined): boolean {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return false;
  }
  if (FINAL_DELIVERABLE_INDICATOR_PATTERN.test(normalized)) {
    return false;
  }
  if (PROGRESS_ONLY_PATTERN.test(normalized)) {
    return true;
  }
  return BARE_PROGRESS_ONLY_PATTERN.test(normalized);
}

export function resolveRequiredCompletionTerminalResult(
  resultText: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalized = normalizeCompletionText(resultText);
  if (!normalized) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    };
  }
  if (isProgressOnlyCompletionText(normalized)) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Required completion ended with progress-only text, not a final deliverable.",
    };
  }
  return {};
}

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalizedReason = normalizeCompletionFailureReason(reason);
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
