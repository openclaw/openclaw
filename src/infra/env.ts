import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/**
 * Load ~/.openclaw/.env into process.env if the file exists.
 * Only keys that are NOT already present in process.env are injected, so
 * real environment variables always take precedence over the file.
 * Lines starting with '#' and blank lines are ignored.
 */
export function loadOpenClawDotEnv(): void {
  // Skip during test runs to avoid polluting the test environment.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;

  const homeDir =
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir();

  if (!homeDir) return;

  const envFilePath = path.join(homeDir, ".openclaw", ".env");

  let content: string;
  try {
    content = fs.readFileSync(envFilePath, "utf-8");
  } catch {
    // File does not exist or is not readable – silently skip.
    return;
  }

  let loaded = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex < 1) continue;

    const key = line.slice(0, eqIndex).trim();
    // Strip optional surrounding quotes from value.
    const rawValue = line.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");

    if (key && !(key in process.env)) {
      process.env[key] = value;
      loaded += 1;
    }
  }

  if (loaded > 0) {
    log.info(`loaded ${loaded} var(s) from ${envFilePath}`);
  }
}

export function normalizeEnv(): void {
  // Load ~/.openclaw/.env first so PMTINSP_* and other keys are available.
  loadOpenClawDotEnv();
  normalizeZaiEnv();

  // Initialize the Prompt Inspector detection client with the now-resolved env.
  // Imported lazily to avoid circular dependency at module parse time.
  import("../security/pi-client.js")
    .then(({ initPiClient }) => {
      initPiClient();
    })
    .catch(() => {
      // Non-fatal: detection simply remains unavailable.
    });
}
