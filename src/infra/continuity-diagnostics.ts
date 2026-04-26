import { emitAgentEvent } from "./agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type ContinuityDiagnosticSeverity = "info" | "warn" | "error";

export type ContinuityDiagnosticRecord = Record<string, unknown>;

export type ContinuityDiagnosticData = {
  type: string;
  severity: ContinuityDiagnosticSeverity;
  phase?: string;
  sessionKey?: string;
  correlation?: ContinuityDiagnosticRecord;
  details?: ContinuityDiagnosticRecord;
};

export type EmitContinuityDiagnosticParams = {
  type: string;
  severity?: ContinuityDiagnosticSeverity;
  phase?: string;
  sessionKey?: string;
  runId?: string;
  correlation?: ContinuityDiagnosticRecord;
  details?: ContinuityDiagnosticRecord;
};

const log = createSubsystemLogger("continuity/diagnostics");

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSeverity(value: unknown): ContinuityDiagnosticSeverity {
  return value === "info" || value === "warn" || value === "error" ? value : "warn";
}

function compactObject(value: unknown): ContinuityDiagnosticRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: ContinuityDiagnosticRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readStringField(record: ContinuityDiagnosticRecord | undefined, key: string): string | undefined {
  return cleanString(record?.[key]);
}

export function emitContinuityDiagnostic(
  params: EmitContinuityDiagnosticParams,
): ContinuityDiagnosticData {
  const type = cleanString(params.type) ?? "diag.unknown";
  const severity = normalizeSeverity(params.severity);
  const phase = cleanString(params.phase);
  const sessionKey = cleanString(params.sessionKey);
  const correlation = compactObject(params.correlation);
  const details = compactObject(params.details);
  const data: ContinuityDiagnosticData = {
    type,
    severity,
    ...(phase ? { phase } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(correlation ? { correlation } : {}),
    ...(details ? { details } : {}),
  };
  const message = `[diagnostic] ${type}${phase ? ` phase=${phase}` : ""}${
    sessionKey ? ` sessionKey=${sessionKey}` : ""
  }`;

  if (severity === "error") {
    log.error(message, data);
  } else if (severity === "warn") {
    log.warn(message, data);
  } else {
    log.info(message, data);
  }

  emitAgentEvent({
    runId:
      cleanString(params.runId) ??
      readStringField(correlation, "approvalId") ??
      readStringField(correlation, "boundaryId") ??
      readStringField(correlation, "childSessionKey") ??
      sessionKey ??
      type,
    stream: "diagnostic",
    ...(sessionKey ? { sessionKey } : {}),
    data,
  });

  return data;
}

export const __testing = {
  cleanString,
  compactObject,
  normalizeSeverity,
};
