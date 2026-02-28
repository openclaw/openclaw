import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

/** No-op on non-macOS platforms. Previously checked for macOS disable-launchagent marker. */
export async function noteMacLaunchAgentOverrides(): Promise<void> {
  // macOS-only; no-op on Linux/WSL
}

/** No-op on non-macOS platforms. Previously checked for launchctl environment overrides. */
export async function noteMacLaunchctlGatewayEnvOverrides(
  _cfg: OpenClawConfig,
  _deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
): Promise<void> {
  // macOS-only; no-op on Linux/WSL
}

export function noteDeprecatedLegacyEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { noteFn?: typeof note },
) {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("CLAWDBOT_") && value?.trim())
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- Deprecated legacy environment variables detected (ignored).",
    "- Use OPENCLAW_* equivalents instead:",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> OPENCLAW_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "Environment");
}
