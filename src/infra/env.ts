import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";

const log = createSubsystemLogger("env");
const loggedEnv = new Set<string>();

type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${singleLine.slice(0, 160)}…`;
}

export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  if (loggedEnv.has(option.key)) {
    return;
  }
  const rawValue = option.value ?? process.env[option.key];
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  loggedEnv.add(option.key);
  log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}

export function normalizeZaiEnv(): void {
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }
}

export function isTruthyEnvValue(value?: string): boolean {
  return parseBooleanValue(value) === true;
}

export function normalizeEnv(): void {
  // NOTE: ~/.openclaw/.env (and OPENCLAW_STATE_DIR/.env) is loaded by
  // loadDotEnv() in run-main.ts, which runs BEFORE this call on the second
  // invocation. Do NOT load it here: normalizeEnv() is also called from
  // entry.ts before loadDotEnv() runs, and loading the global file at that
  // point would let it shadow CWD .env values (wrong precedence).
  //
  // Prompt Inspector (pi-client.ts) uses lazy init: the first detectSafety()
  // call invokes initPiClient() internally, by which time loadDotEnv() has
  // already populated process.env with PMTINSP_API_KEY / PMTINSP_BASE_URL.
  normalizeZaiEnv();
}
