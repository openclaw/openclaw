import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

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
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionLine = `Description=${description?.trim() || "OpenClaw Gateway"}`;
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
    // KillMode=mixed sends SIGTERM to the main process for graceful shutdown,
    // then SIGKILL to all remaining cgroup processes (orphaned children like
    // podman conmon, headless chrome, etc.) after TimeoutStopSec.
    // Using "process" here would leave the gateway child alive across restarts,
    // causing port conflicts.
    "KillMode=mixed",
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
