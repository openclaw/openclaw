import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { unwrapToolCallForDisplay } from "../agents/tool-display-call.js";
import { readTranscriptDisplayPosition } from "../chat/transcript-display-position.js";

/** Producer-confirmed completion, independent of the child's later session state. */
export type SubagentCompletion = {
  runId: string;
  sessionKey: string;
  label?: string;
  /** Absent for a finished child; a collected child that ended without finishing. */
  outcome?: SubagentCompletionOutcome;
};

const SUBAGENT_COMPLETION_OUTCOMES = ["failed", "killed", "timeout"] as const;
export type SubagentCompletionOutcome = (typeof SUBAGENT_COMPLETION_OUTCOMES)[number];

function readOutcome(value: unknown): SubagentCompletionOutcome | undefined {
  return SUBAGENT_COMPLETION_OUTCOMES.find((outcome) => outcome === value);
}

/** A child's terminal producer status as a display fact; an unknown end yields none. */
export function subagentCompletionForOutcome(
  child: { runId: string; sessionKey: string; label?: string },
  status: string | undefined,
  killed = false,
): SubagentCompletion | undefined {
  const outcome = killed
    ? "killed"
    : status === "timeout"
      ? "timeout"
      : status === "error"
        ? "failed"
        : undefined;
  return outcome || status === "ok" ? { ...child, ...(outcome ? { outcome } : {}) } : undefined;
}

export function readSubagentCompletions(value: unknown): SubagentCompletion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asOptionalRecord(item);
    const runId = normalizeOptionalString(record?.runId);
    const sessionKey = normalizeOptionalString(record?.sessionKey);
    const label = normalizeOptionalString(record?.label);
    const outcome = readOutcome(record?.outcome);
    return runId && sessionKey
      ? [{ runId, sessionKey, ...(label ? { label } : {}), ...(outcome ? { outcome } : {}) }]
      : [];
  });
}

export function messageSubagentCompletions(message: unknown): SubagentCompletion[] {
  const record = asOptionalRecord(message);
  return Array.isArray(record?.content) &&
    record.content.some((block) => asOptionalRecord(block)?.type === "subagent_completion")
    ? readSubagentCompletions(record.subagentCompletions)
    : [];
}

/** A display-only projection: never carry the private coordination prompt or result. */
export function subagentCompletionMessage(
  source: unknown,
  completions: readonly SubagentCompletion[],
  options: { timestamp?: number; derived?: boolean } = {},
) {
  const record = asOptionalRecord(source);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  const position = options.derived
    ? undefined
    : readTranscriptDisplayPosition(metadata?.transcriptPosition);
  const runId =
    normalizeOptionalString(metadata?.steerTargetRunId) ??
    normalizeOptionalString(metadata?.runId) ??
    normalizeOptionalString(record?.runId);
  return {
    role: "assistant",
    phase: "commentary",
    display: true,
    content: [{ type: "subagent_completion" }],
    timestamp: options.timestamp ?? record?.timestamp,
    subagentCompletions: completions,
    ...(runId ? { runId } : {}),
    __openclaw: {
      ...(position ? { transcriptPosition: position } : {}),
      ...(metadata?.id ? { id: metadata.id } : {}),
      ...(runId ? { runId } : {}),
      ...(metadata?.seq !== undefined ? { seq: metadata.seq } : {}),
    },
  };
}

/** The agents_wait output from its structured result, details or JSON text. */
function readCollection(value: unknown) {
  const result = asOptionalRecord(value);
  const details = asOptionalRecord(result?.details);
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(result?.content)
        ? result.content
            .flatMap((block) => {
              const item = asOptionalRecord(block);
              return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
            })
            .join("\n")
        : undefined;
  const isCollection = (record: Record<string, unknown> | undefined) =>
    Array.isArray(record?.completed) || Array.isArray(record?.errors);
  return isCollection(result)
    ? result
    : isCollection(details)
      ? details
      : text
        ? safeParseJsonRecord(text)
        : undefined;
}

/** Per-ID collection errors (not found, not owned) have no completion row. */
export function readCollectionErrorCount(value: unknown): number {
  const errors = readCollection(value)?.errors;
  return Array.isArray(errors) ? errors.length : 0;
}

/** Only callers that have identified an agents_wait result may use this parser. */
export function readCollectedSubagentCompletions(value: unknown): SubagentCompletion[] {
  const parsed = readCollection(value);
  // Every settled child gets a row: a failure must not disappear with its hidden wait.
  return readSubagentCompletions(
    Array.isArray(parsed?.completed)
      ? parsed.completed.flatMap((entry) => {
          const record = asOptionalRecord(entry);
          const outcome = readOutcome(record?.status);
          return record?.status === "done" ? [record] : outcome ? [{ ...record, outcome }] : [];
        })
      : [],
  );
}

/** Keep compact collection facts before the ordinary output is bounded for display. */
export function preserveCollectedSubagentCompletions<T>(message: T): T {
  const record = asOptionalRecord(message);
  const role = typeof record?.role === "string" ? record.role.toLowerCase() : "";
  const name = record?.toolName ?? record?.tool_name ?? record?.name;
  if (
    asOptionalRecord(record?.["__openclaw"])?.catalogSource === true ||
    !["toolresult", "tool_result", "tool", "function"].includes(role) ||
    typeof name !== "string" ||
    unwrapToolCallForDisplay({ name }).name !== "agents_wait"
  ) {
    return message;
  }
  const retained = readSubagentCompletions(record?.subagentCompletions);
  const completions = retained.length ? retained : readCollectedSubagentCompletions(record);
  const errors =
    typeof record?.subagentCollectionErrors === "number"
      ? record.subagentCollectionErrors
      : readCollectionErrorCount(record);
  if (!completions.length && !errors) {
    return message;
  }
  const preserved = {
    ...record,
    ...(completions.length ? { subagentCompletions: completions } : {}),
    ...(errors ? { subagentCollectionErrors: errors } : {}),
  };
  // SAFETY: the record is the caller's message; adding facts keeps its shape.
  return preserved as T;
}
