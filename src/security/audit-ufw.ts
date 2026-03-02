/**
 * UFW (firewall) detection for security audit on Linux.
 *
 * Does not rely on PATH: checks standard sbin locations and optionally
 * /etc/ufw/ufw.conf so we report accurately when ufw is installed but
 * not on the user's PATH (see GitHub issue #30361).
 */
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import { runExec } from "../process/exec.js";

const UFW_BINARY_CANDIDATES = ["/usr/sbin/ufw", "/sbin/ufw", "/usr/local/sbin/ufw"];

const UFW_CONF_PATH = "/etc/ufw/ufw.conf";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

export type ExecUfwFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

function resolveUfwBinarySync(): string | null {
  for (const candidate of UFW_BINARY_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  // Fallback: check if ufw is on PATH (covers non-standard install locations)
  // Only consider absolute paths to avoid executing cwd-relative binaries like ./ufw
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    if (!dir.startsWith("/")) {
      continue;
    }
    const candidate = `${dir}/ufw`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function readUfwConfEnabled(): Promise<boolean | null> {
  try {
    const raw = await fsAsync.readFile(UFW_CONF_PATH, "utf-8");
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("ENABLED="));
    if (!line) {
      return null;
    }
    const value = line.slice("ENABLED=".length).trim().toLowerCase();
    return value === "yes";
  } catch {
    return null;
  }
}

/**
 * Collect UFW firewall findings on Linux only.
 * Uses sbin paths and config file so we do not falsely report "UFW not found"
 * when ufw is installed but not on PATH.
 *
 * For tests, pass resolveUfwBinary and readUfwConfEnabled to avoid fs access.
 */
export async function collectUfwFindings(params: {
  platform: NodeJS.Platform;
  execUfwFn?: ExecUfwFn;
  /** Override for tests: return path to ufw binary or null. */
  resolveUfwBinary?: () => string | null;
  /** Override for tests: return ENABLED=yes (true), no (false), or unknown (null). */
  readUfwConfEnabled?: () => Promise<boolean | null>;
}): Promise<SecurityAuditFinding[]> {
  if (params.platform !== "linux") {
    return [];
  }

  const execFn = params.execUfwFn ?? runExec;
  const binary = params.resolveUfwBinary ? params.resolveUfwBinary() : resolveUfwBinarySync();

  if (!binary) {
    return [];
  }

  const statusResult = await execFn(binary, ["status"], { timeoutMs: 3000 }).catch(
    (err) => ({ error: String(err), stdout: "", stderr: "" }) as const,
  );
  const confEnabled = params.readUfwConfEnabled
    ? await params.readUfwConfEnabled()
    : await readUfwConfEnabled();

  const hasError = "error" in statusResult;
  const stdout = statusResult.stdout ?? "";
  const active = /Status:\s*active/i.test(stdout);

  if (!hasError) {
    return [
      {
        checkId: "host.ufw",
        severity: "info",
        title: active ? "UFW active" : "UFW inactive",
        detail: active
          ? "Host firewall (ufw) is active."
          : "Host firewall (ufw) is installed but inactive.",
        remediation: active
          ? undefined
          : "Consider enabling: sudo ufw enable (ensure SSH is allowed first).",
      },
    ];
  }

  const errMsg = hasError ? (statusResult as { error: string }).error : "";
  // Only treat as "binary absent" when exec failed to run the binary (ENOENT).
  // Do not match "command not found": String(err) can include child stderr, so
  // ufw running but failing with "iptables: command not found" would be misclassified.
  const commandNotFound = hasError && /ENOENT|spawn.*ENOENT/i.test(errMsg);

  if (commandNotFound) {
    return [];
  }

  const binaryLocation = `binary at ${binary}`;
  const confEnabledStr =
    confEnabled === true
      ? "UFW enabled (per /etc/ufw/ufw.conf)"
      : `UFW installed (${binaryLocation})`;
  const detail =
    confEnabled === true
      ? `${confEnabledStr}; status check requires sudo.`
      : `${confEnabledStr}; status check failed — may require sudo.`;

  return [
    {
      checkId: "host.ufw",
      severity: "info",
      title: "UFW status unknown",
      detail,
      remediation: `Run: sudo ufw status`,
    },
  ];
}
