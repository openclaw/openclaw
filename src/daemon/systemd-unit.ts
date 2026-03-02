import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

const SYSTEMD_LINE_BREAKS = /[\r\n]/;

function assertNoSystemdLineBreaks(value: string, label: string): void {
  if (SYSTEMD_LINE_BREAKS.test(value)) {
    throw new Error(`${label} cannot contain CR or LF characters.`);
  }
}

function systemdEscapeArg(value: string): string {
  assertNoSystemdLineBreaks(value, "Systemd unit values");
  if (!/[\s"\\]/.test(value)) {
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
  return entries.map(([key, value]) => {
    const rawValue = value ?? "";
    assertNoSystemdLineBreaks(key, "Systemd environment variable names");
    assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
    return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
  });
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
  const descriptionLine = `Description=${descriptionValue}`;
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
    // KillMode=process ensures systemd only waits for the main process to exit.
    // Without this, podman's conmon (container monitor) processes block shutdown
    // since they run as children of the gateway and stay in the same cgroup.
    "KillMode=process",
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

function stripSystemdExecPrefix(token: string): string {
  let out = token;
  while (out && /^[-@:+!]/.test(out)) {
    out = out.slice(1);
  }
  return out;
}

function envOptionConsumesNextValue(token: string): boolean {
  if (!token.startsWith("-")) {
    return false;
  }
  if (token.includes("=")) {
    return false;
  }
  return (
    token === "-u" ||
    token === "-C" ||
    token === "-S" ||
    token === "--unset" ||
    token === "--chdir" ||
    token === "--split-string" ||
    token === "--argv0"
  );
}

function extractEnvInlineSplitStringValue(token: string): string | null {
  if (token.startsWith("--split-string=")) {
    return token.slice("--split-string=".length);
  }
  if (token.startsWith("-S") && token.length > 2) {
    return token.slice(2);
  }
  return null;
}

export function collectSystemdExecStartValues(contents: string): string[] {
  const logicalLines: string[] = [];
  let currentLine = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine && !currentLine) {
      continue;
    }
    const hasContinuation = /\\\s*$/.test(trimmedLine);
    const linePart = trimmedLine.replace(/\\\s*$/, "").trim();
    currentLine = currentLine ? `${currentLine} ${linePart}`.trim() : linePart;
    if (hasContinuation) {
      continue;
    }
    logicalLines.push(currentLine);
    currentLine = "";
  }

  if (currentLine) {
    logicalLines.push(currentLine);
  }

  const values: string[] = [];
  let inServiceSection = false;
  for (const line of logicalLines) {
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      inServiceSection = sectionMatch[1]?.trim().toLowerCase() === "service";
      continue;
    }
    if (!inServiceSection) {
      continue;
    }
    const match = line.match(/^execstart\s*=(.*)$/i);
    if (match) {
      values.push(match[1]?.trim() ?? "");
    }
  }
  return values;
}

export function extractSystemdExecStartCommandToken(execStartValue: string): string | null {
  const tokens = parseSystemdExecStart(execStartValue);
  if (tokens.length === 0) {
    return null;
  }

  let index = 0;
  while (index < tokens.length) {
    const token = stripSystemdExecPrefix(tokens[index] ?? "");
    if (!token) {
      index += 1;
      continue;
    }

    if (token.toLowerCase().endsWith("/env") || token.toLowerCase() === "env") {
      const pending = tokens.slice(index + 1);
      while (pending.length > 0) {
        const envToken = pending.shift() ?? "";
        if (!envToken) {
          continue;
        }
        const inlineSplitValue = extractEnvInlineSplitStringValue(envToken);
        if (inlineSplitValue) {
          const expanded = parseSystemdExecStart(inlineSplitValue);
          if (expanded.length > 0) {
            pending.unshift(...expanded);
          }
          continue;
        }
        if (envOptionConsumesNextValue(envToken)) {
          const optionValue = pending.shift();
          if ((envToken === "-S" || envToken === "--split-string") && optionValue) {
            const expanded = parseSystemdExecStart(optionValue);
            if (expanded.length > 0) {
              pending.unshift(...expanded);
            }
          }
          continue;
        }
        if (envToken.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(envToken)) {
          continue;
        }
        return stripSystemdExecPrefix(envToken);
      }
      return null;
    }

    return token;
  }

  return null;
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
