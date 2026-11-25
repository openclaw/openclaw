import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Just what a confirmed card can display or compare-and-swap. Never transport payload,
 * command, paths, trigger options, credentials, or a creator's write permission. */
export type AutomationSavedDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  configRevision: string;
  ownerProfileId?: string;
  schedule?:
    | { kind: "at"; at: string }
    | { kind: "every"; everyMs: number }
    | { kind: "cron"; expr: string; tz?: string };
};
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function scheduleSummary(raw: unknown): AutomationSavedDefinition["schedule"] {
  const s = asOptionalRecord(raw);
  if (s?.kind === "at" && bounded(s.at, 128)) {
    return { kind: "at", at: s.at };
  }
  if (
    s?.kind === "every" &&
    typeof s.everyMs === "number" &&
    Number.isSafeInteger(s.everyMs) &&
    s.everyMs > 0
  ) {
    return { kind: "every", everyMs: s.everyMs };
  }
  if (s?.kind === "cron" && bounded(s.expr, 512) && (s.tz === undefined || bounded(s.tz, 128))) {
    return { kind: "cron", expr: s.expr, ...(s.tz ? { tz: s.tz } : {}) };
  }
  return undefined;
}
/** Bind the snapshot to the confirmed scheduler ID. Missing/old metadata falls back to cron.get. */
export function readAutomationSavedDefinition(
  value: unknown,
  jobId: string,
): AutomationSavedDefinition | undefined {
  const job = asOptionalRecord(value);
  if (
    job?.id !== jobId ||
    !bounded(job.name, 512) ||
    typeof job.enabled !== "boolean" ||
    !bounded(job.configRevision, 128)
  ) {
    return undefined;
  }
  const schedule = scheduleSummary(job.schedule);
  return {
    id: jobId,
    name: bounded(job.displayName, 512) ? job.displayName : job.name,
    enabled: job.enabled,
    configRevision: job.configRevision,
    ...(bounded(job.ownerProfileId, 256) ? { ownerProfileId: job.ownerProfileId } : {}),
    ...(schedule ? { schedule } : {}),
  };
}
