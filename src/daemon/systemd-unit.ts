import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

export const SYSTEMD_KILL_MODES = ["process", "mixed", "control-group"] as const;
export type SystemdKillMode = (typeof SYSTEMD_KILL_MODES)[number];

function systemdEscapeArg(value: string): string {
  if (!/[\\s"\\\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"')}"`;
}

function renderEnvLines(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) {
    return [];
  }
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) {
    return [];
  }
  return entries.map(
    ([key, value]) => `Environment=${systemdEscapeArg(`${key}=${value?.trim() ?? ""}`)}`,
  );
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
  killMode,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionLine = `Description=${description?.trim() || "OpenClaw Gateway"}`;
  const resolvedKillMode = killMode ?? "process";
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const envLines = renderEnvLines(environment);
  return [
    "[Unit]",
    descriptionLine,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    // KillMode defaults to process.
    // Without this, podman's conmon (container monitor) processes block shutdown
    // since they run as children of the gateway and stay in the same cgroup.
    `KillMode=${resolvedKillMode}`,
    workingDirLine,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function parseSystemdExecStart(value: string): string[] {
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}

export function parseSystemdEnvAssignment(raw: string): { key: string; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const unquoted = (() => {
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed;
    }
    let out = "";
    let escapeNext = false;
    for (const ch of trimmed.slice(1, -1)) {
      if (escapeNext) {
        out += ch;
        escapeNext = false;
        continue;
      }
      if (ch === "\\\\") {
        escapeNext = true;
        continue;
      }
      out += ch;
    }
    return out;
  })();

  const eq = unquoted.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = unquoted.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const value = unquoted.slice(eq + 1);
  return { key, value };
}
