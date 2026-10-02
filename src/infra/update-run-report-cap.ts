import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunReportHealth } from "./update-run-report-health.js";

const REPORT_DETAILS_OMITTED_COMPACT = "… run openclaw update status";
const SERVICE_RESTART_COMMAND_MARKER = "After the update, run: ";

export function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceUtf16Safe(text, 0, limit - 1)}…`;
}

export function formatUpdateRunCurrentHealth(health: UpdateRunReportHealth): string {
  return health.kind === "responding"
    ? `Current health: Gateway answered on the recorded port (${bounded(health.version, 120)}).`
    : "Current health unavailable; saved verification describes the update attempt only.";
}

export function compactHeadline(
  run: Pick<UpdateRunRecord, "status" | "reason">,
  headline: string,
  reconciled: boolean,
): string {
  return reconciled
    ? "ℹ️ Reconciled."
    : run.status === "succeeded"
      ? "✅ Updated."
      : run.status === "failed"
        ? run.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON
          ? "ℹ️ Update abandoned."
          : "⚠️ Failed."
        : run.status === "skipped"
          ? run.reason === "still-starting" || run.reason === "gateway-readiness-unverified"
            ? "ℹ️ Installed; readiness unverified."
            : "ℹ️ Update skipped."
          : run.status === "rolled-back"
            ? "↩️ Rolled back."
            : headline;
}

export function renderRuntimeDetails(input: {
  headline: string;
  compactHeadline: string;
  actionLine?: string;
  details: string[];
  reasonLine: string;
  safetyLines: string[];
  omitReason: boolean;
  reservedLine?: string;
}): string {
  const details = input.details.join("\n");
  const fullLead = [input.headline, ...(input.actionLine ? [input.actionLine] : []), ""].join("\n");
  const fullBudget = 1500 - fullLead.length - 1;
  if (details.length <= fullBudget) {
    return `${fullLead}\n${details}`;
  }
  const protectedLines = input.safetyLines.length
    ? [input.reasonLine, ...input.safetyLines]
    : ["Details:", input.reasonLine];
  const protectedBody = [
    protectedLines[0],
    REPORT_DETAILS_OMITTED_COMPACT,
    ...protectedLines.slice(1),
  ].join("\n");
  if (protectedBody.length <= fullBudget) {
    return `${fullLead}\n${protectedBody}`;
  }
  const compactLead = [
    input.compactHeadline,
    ...(input.actionLine ? [input.actionLine] : []),
    "",
  ].join("\n");
  const compactBudget = 1500 - compactLead.length - 1;
  if (protectedBody.length <= compactBudget) {
    return `${compactLead}\n${protectedBody}`;
  }
  const pressuredLines =
    input.omitReason && input.safetyLines.length ? input.safetyLines : protectedLines;
  return `${compactLead}\n${renderProtected(pressuredLines, compactBudget, input.reservedLine)}`;
}

function protectedLabelLength(text: string): number {
  const separator = text.indexOf(":");
  if (separator < 0) {
    return Math.min(text.length, 40);
  }
  return separator + (text[separator + 1] === " " ? 2 : 1);
}

function boundedEdges(text: string, limit: number, protectedPrefix: number): string {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return limit === 1 ? "…" : "";
  }
  const prefix = Math.min(protectedPrefix, limit - 1);
  if (limit === prefix + 1) {
    return `${sliceUtf16Safe(text, 0, prefix)}…`;
  }
  // Protected facts keep their complete label and trailing operator detail; prefix-only
  // truncation can retain prose while hiding the action that makes the warning useful.
  const tail = Math.max(1, Math.floor((limit - prefix - 1) / 2));
  return `${sliceUtf16Safe(text, 0, limit - tail - 1)}…${sliceUtf16Safe(text, -tail)}`;
}

function boundedProtectedLine(text: string, limit: number): string {
  return boundedEdges(text, limit, protectedLabelLength(text));
}

export function formatServiceWarning(message: string): {
  report: string;
  protected: string;
  reserve: boolean;
} {
  // The system-service owner appends the only safe restart command after this marker.
  const commandAt = message.lastIndexOf(SERVICE_RESTART_COMMAND_MARKER);
  const warning = `Warning: ${message}`;
  const restartCommand =
    commandAt < 0 ? undefined : message.slice(commandAt + SERVICE_RESTART_COMMAND_MARKER.length);
  const reportLine =
    commandAt < 0 ? warning : `Warning: operator restart required: ${restartCommand}`;
  return {
    report: warning.length <= 509 ? warning : boundedProtectedLine(reportLine, 509),
    protected: restartCommand ? `Restart: ${restartCommand}` : warning,
    reserve: commandAt >= 0,
  };
}

export function renderProtected(lines: string[], limit: number, reservedLine?: string): string {
  const required = lines.filter(Boolean);
  const contentBudget = limit - REPORT_DETAILS_OMITTED_COMPACT.length - required.length;
  if (required.length === 0 || contentBudget < required.length) {
    return bounded(REPORT_DETAILS_OMITTED_COMPACT, limit);
  }
  const entries = required.map((line) => {
    const labelLength = protectedLabelLength(line);
    return {
      line,
      labelLength,
      allocation: Math.min(line.length, labelLength + (line.length > labelLength ? 1 : 0)),
    };
  });
  const reserved = reservedLine ? entries.find((entry) => entry.line === reservedLine) : undefined;
  let remaining = contentBudget - entries.reduce((sum, entry) => sum + entry.allocation, 0);
  if (remaining < 0) {
    return bounded(REPORT_DETAILS_OMITTED_COMPACT, limit);
  }
  // The owner-provided restart command gets first claim after every label. Flexible facts then
  // water-fill the residual budget, so short lines donate unused capacity to longer facts.
  if (reserved) {
    const grant = Math.min(reserved.line.length - reserved.allocation, remaining);
    reserved.allocation += grant;
    remaining -= grant;
  }
  while (remaining > 0) {
    const expandable = entries.filter(
      (entry) => entry !== reserved && entry.allocation < entry.line.length,
    );
    if (expandable.length === 0) {
      break;
    }
    const share = Math.max(1, Math.floor(remaining / expandable.length));
    for (const entry of expandable) {
      const grant = Math.min(entry.line.length - entry.allocation, share, remaining);
      entry.allocation += grant;
      remaining -= grant;
    }
  }
  const protectedLines = entries.map((entry) =>
    boundedEdges(entry.line, entry.allocation, entry.labelLength),
  );
  return [protectedLines[0], REPORT_DETAILS_OMITTED_COMPACT, ...protectedLines.slice(1)].join("\n");
}
