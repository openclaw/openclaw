import { stat } from "node:fs/promises";
import path from "node:path";
import type { SecurityFinding } from "./types.js";

export const SENSITIVE_PATHS = [
  { path: ".openclaw/openclaw.json", expectedMode: 0o600 },
  { path: ".openclaw/openclaw.json.bak", expectedMode: 0o600 },
  { path: ".openclaw/.env", expectedMode: 0o600 },
  { path: ".openclaw/credentials", expectedMode: 0o700 },
  { path: ".openclaw/agents", expectedMode: 0o700 },
  { path: ".openclaw/signals", expectedMode: 0o700 },
  { path: ".ssh", expectedMode: 0o700 },
  { path: ".ssh/id_rsa", expectedMode: 0o600 },
  { path: ".ssh/id_ed25519", expectedMode: 0o600 },
  { path: ".ssh/authorized_keys", expectedMode: 0o600 },
  { path: ".bash_history", expectedMode: 0o600 },
  { path: ".zsh_history", expectedMode: 0o600 },
];

export async function auditPermissions(homeDir: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  for (const sensitive of SENSITIVE_PATHS) {
    const fullPath = path.join(homeDir, sensitive.path);
    try {
      const fileStat = await stat(fullPath);
      const mode = fileStat.mode & 0o777;

      if (mode > sensitive.expectedMode) {
        const isWorldReadable = (mode & 0o044) !== 0;
        const isWorldWritable = (mode & 0o022) !== 0;
        const severity = isWorldWritable ? "CRITICAL" : isWorldReadable ? "HIGH" : "MEDIUM";

        findings.push({
          id: `perm:${sensitive.path.replace(/\//g, "-")}`,
          severity,
          category: "permission",
          message: `${sensitive.path} has permissions ${mode.toString(8)} (expected ≤ ${sensitive.expectedMode.toString(8)})`,
          file: sensitive.path,
          remediation: `Run: chmod ${sensitive.expectedMode.toString(8)} ~/${sensitive.path}`,
        });
      }
    } catch {
      // File doesn't exist — not a finding
    }
  }

  return findings;
}
