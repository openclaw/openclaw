import os from "node:os";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { runExec } from "../process/exec.js";

// Prefer macOS ComputerName/LocalHostName with hostname fallback; machine
// identity is process-stable, so retain the first outcome until restart.
let cachedPromise: Promise<string> | null = null;

async function tryScutil(key: "ComputerName" | "LocalHostName") {
  try {
    const { stdout } = await runExec("/usr/sbin/scutil", ["--get", key], {
      logOutput: false,
      timeoutMs: 1000,
    });
    return normalizeNullableString(stdout);
  } catch {
    return null;
  }
}

function fallbackHostName() {
  const trimmed = normalizeNullableString(os.hostname()) ?? "";
  return trimmed.replace(/\.local$/i, "") || "openclaw";
}

/** Resolve a user-facing name for the current machine. */
export async function getMachineDisplayName(): Promise<string> {
  if (cachedPromise) {
    return cachedPromise;
  }
  cachedPromise = (async () => {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
      return fallbackHostName();
    }
    if (process.platform === "darwin") {
      const computerName = await tryScutil("ComputerName");
      if (computerName) {
        return computerName;
      }
      const localHostName = await tryScutil("LocalHostName");
      if (localHostName) {
        return localHostName;
      }
    }
    return fallbackHostName();
  })();
  return cachedPromise;
}
