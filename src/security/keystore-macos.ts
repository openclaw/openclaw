/**
 * macOS Keychain backend for credential keystore.
 *
 * Uses `security` CLI (execFileSync) to avoid shell interpretation of values,
 * following the same pattern proven in src/agents/cli-credentials.ts.
 */

import { execFileSync } from "node:child_process";
import type { KeystoreBackend } from "./credential-keystore.js";

const SECURITY_TIMEOUT_MS = 5000;
const SECURITY_STDIO: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

function securityExec(args: string[]): string | null {
  try {
    return execFileSync("security", args, {
      encoding: "utf8",
      timeout: SECURITY_TIMEOUT_MS,
      stdio: SECURITY_STDIO,
    }).trim();
  } catch {
    return null;
  }
}

export const macosKeystoreBackend: KeystoreBackend = {
  isAvailable(): boolean {
    // Verify `security` binary is reachable.
    return securityExec(["help"]) !== null;
  },

  store(service: string, account: string, value: string): boolean {
    // -U flag updates the existing item if it already exists (upsert semantics).
    // Using execFileSync avoids shell interpretation of the value string.
    try {
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value],
        {
          encoding: "utf8",
          timeout: SECURITY_TIMEOUT_MS,
          stdio: SECURITY_STDIO,
        },
      );
      return true;
    } catch {
      return false;
    }
  },

  retrieve(service: string, account: string): string | null {
    return securityExec(["find-generic-password", "-s", service, "-a", account, "-w"]);
  },

  delete(service: string, account: string): boolean {
    try {
      execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], {
        encoding: "utf8",
        timeout: SECURITY_TIMEOUT_MS,
        stdio: SECURITY_STDIO,
      });
      return true;
    } catch {
      return false;
    }
  },
};
