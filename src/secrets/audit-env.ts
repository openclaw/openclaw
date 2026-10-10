import fs from "node:fs";
import { listKnownSecretEnvVarNames } from "./provider-env-vars.js";
import { parseEnvAssignmentValue } from "./storage-scan.js";

/** Returns undefined for an absent file so the audit records only scanned paths. */
export function findEnvPlaintextFindings(envPath: string) {
  if (!fs.existsSync(envPath)) {
    return undefined;
  }
  const knownKeys = new Set(listKnownSecretEnvVarNames());
  const findings = [];
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    if (!knownKeys.has(key) || !parseEnvAssignmentValue(match[2] ?? "")) {
      continue;
    }
    findings.push({
      code: "PLAINTEXT_FOUND" as const,
      severity: "warn" as const,
      file: envPath,
      jsonPath: `$env.${key}`,
      message: `Potential secret found in .env (${key}).`,
    });
  }
  return findings;
}
