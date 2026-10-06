import type { CronRunLogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetailFully } from "../../lib/browser-redact.ts";
import { clampText } from "../../lib/format.ts";

function safeFact(value: string, max: number): string {
  // Source fields are redacted before shortening so a cut-off key cannot evade masking.
  const redacted = redactToolDetailFully(value).replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gu,
    "[redacted private key]",
  );
  return clampText(redacted, max);
}

function runFacts(entry: CronRunLogEntry, diagnosticLimit?: number) {
  return JSON.stringify(
    {
      jobId: safeFact(entry.jobId, 120),
      ...(entry.jobName ? { jobName: safeFact(entry.jobName, 120) } : {}),
      ...(entry.runId ? { runId: safeFact(entry.runId, 120) } : {}),
      ...(typeof entry.runAtMs === "number" && Number.isFinite(entry.runAtMs)
        ? { runAtMs: entry.runAtMs, runAt: new Date(entry.runAtMs).toISOString() }
        : {}),
      finishedAt: new Date(entry.ts).toISOString(),
      status: entry.status ?? "unknown",
      issue:
        entry.deliveryError &&
        !entry.error &&
        entry.status !== "error" &&
        entry.completionStatus !== "failed"
          ? "delivery error"
          : "run error",
      ...(entry.completionStatus ? { completionStatus: entry.completionStatus } : {}),
      ...(entry.deliveryStatus ? { deliveryStatus: entry.deliveryStatus } : {}),
      ...(entry.error && diagnosticLimit ? { error: safeFact(entry.error, diagnosticLimit) } : {}),
      ...(entry.deliveryError && diagnosticLimit
        ? { deliveryError: safeFact(entry.deliveryError, diagnosticLimit) }
        : {}),
      ...(entry.summary && diagnosticLimit
        ? { summary: safeFact(entry.summary, diagnosticLimit) }
        : {}),
      ...(entry.diagnostics && diagnosticLimit
        ? {
            diagnostics: {
              ...(entry.diagnostics.summary
                ? { summary: safeFact(entry.diagnostics.summary, 400) }
                : {}),
              entries: entry.diagnostics.entries.slice(-3).map((item) => ({
                source: item.source,
                severity: item.severity,
                message: safeFact(item.message, 300),
                toolName: item.toolName ? safeFact(item.toolName, 80) : undefined,
                exitCode: item.exitCode,
              })),
            },
          }
        : {}),
    },
    null,
    2,
  );
}

export function isCronRunRepairable(entry: CronRunLogEntry): boolean {
  return (
    entry.status === "error" ||
    entry.completionStatus === "failed" ||
    Boolean(entry.error || entry.deliveryError)
  );
}

export function cronRepairRunKey(entry: CronRunLogEntry): string {
  return JSON.stringify([entry.jobId, entry.runId ?? null, entry.ts]);
}

export function buildCronRepairPrompt(entry: CronRunLogEntry): string {
  return t("cron.runEntry.repairPrompt", { facts: runFacts(entry, 1_200) });
}

export function buildCronRepairDraft(entry: CronRunLogEntry): string {
  return t("cron.runEntry.repairDraft", { facts: runFacts(entry) });
}
