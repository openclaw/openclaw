import { appendFileSync } from "node:fs";

const DIAG_LOG_PATH = "/tmp/diag.log";

function safe(value: unknown): string {
  try {
    if (value === undefined) {
      return "undefined";
    }
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function writeSlackDiag(message: string) {
  try {
    appendFileSync(DIAG_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best-effort diagnostics only.
  }
}

export function writeSlackDiagKv(tag: string, fields: Record<string, unknown>) {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${safe(v)}`);
  writeSlackDiag(`${tag} ${parts.join(" ")}`.trim());
}
