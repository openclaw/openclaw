import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** A diagnostic-only display row owned by the settled run, not a model attempt. */
export type RunFailureNotice = { runId: string; summary: string };

export function readRunFailureNotice(message: unknown): RunFailureNotice | undefined {
  const notice = asOptionalRecord(asOptionalRecord(message)?.openclawRunError);
  if (
    typeof notice?.runId !== "string" ||
    !notice.runId.trim() ||
    typeof notice.summary !== "string" ||
    !notice.summary.trim()
  ) {
    return undefined;
  }
  return { runId: notice.runId, summary: notice.summary };
}
