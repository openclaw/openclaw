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
    // Keep service children in the same lifecycle so restarts do not leave
    // orphan ACP/runtime workers behind.
    "KillMode=control-group",
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

function stripSurroundingQuotes(token: string): string {
  let out = token.trim();
  while (out.length >= 2) {
    const quote = out[0];
    if ((quote === "'" || quote === '"') && out.at(-1) === quote) {
      out = out.slice(1, -1).trim();
      continue;
    }
    break;
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

// GNU env short-option characters: flags take no argument, value-opts consume one.
const ENV_SHORT_FLAGS = "i0v";
const ENV_SHORT_VALUE_OPTS = "uCS";

/**
 * Parses a clustered short-option token (e.g. "-iu", "-i0S") used with env.
 * Returns null when the token is not a recognised cluster (length < 3 or
 * contains unknown characters).  Otherwise returns whether the cluster
 * consumes the next argument, whether the consuming option is -S (split-string),
 * and any inline value attached to the consuming option.
 */
function parseEnvShortOptionCluster(
  token: string,
): { consumesNext: boolean; isSplitString: boolean; inlineValue: string | null } | null {
  // Single-char options (-u, -S …) are handled by existing exact-match code.
  if (!token.startsWith("-") || token.startsWith("--") || token.length < 3) {
    return null;
  }
  for (let i = 1; i < token.length; i++) {
    const ch = token[i];
    if (ENV_SHORT_FLAGS.includes(ch)) {
      continue;
    }
    if (ENV_SHORT_VALUE_OPTS.includes(ch)) {
      const rest = token.slice(i + 1);
      return rest
        ? { consumesNext: false, isSplitString: ch === "S", inlineValue: rest }
        : { consumesNext: true, isSplitString: ch === "S", inlineValue: null };
    }
    // Unknown character — not a recognised cluster.
    return null;
  }
  // All flag characters, no value consumed.
  return { consumesNext: false, isSplitString: false, inlineValue: null };
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

function hasUnescapedTrailingBackslash(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === "\\") {
      count++;
    } else {
      break;
    }
  }
  return count % 2 === 1;
}

export function collectSystemdExecStartValues(contents: string): string[] {
  const logicalLines: string[] = [];
  let currentLine = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine && !currentLine) {
      continue;
    }
    // Only an odd number of trailing backslashes is a continuation;
    // even count (e.g. \\) represents escaped literal backslashes.
    const hasContinuation = hasUnescapedTrailingBackslash(trimmedLine);
    const linePart = hasContinuation ? trimmedLine.slice(0, -1).trim() : trimmedLine;
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

export type ResolvedExecStart = {
  /** The effective executable token (systemd prefix-stripped, quote-stripped), or null. */
  command: string | null;
  /** Remaining runtime tokens after the command (quote-stripped). */
  args: string[];
};

/**
 * Resolves an ExecStart value into its effective command and arguments,
 * unwrapping `env` wrappers, option flags, KEY=VALUE assignments, and
 * `--split-string` / `-S` payloads.
 */
export function resolveExecStartCommand(execStartValue: string): ResolvedExecStart {
  const tokens = parseSystemdExecStart(execStartValue);
  if (tokens.length === 0) {
    return { command: null, args: [] };
  }

  const firstToken = stripSurroundingQuotes(stripSystemdExecPrefix(tokens[0] ?? ""));
  if (!firstToken) {
    return { command: null, args: [] };
  }

  // Non-env path: first token is the command, rest are args.
  if (!isEnvCommandToken(firstToken)) {
    return { command: firstToken, args: tokens.slice(1).map(stripSurroundingQuotes) };
  }

  // Env wrapper path: walk past env options/assignments to find the real command.
  const pending = tokens.slice(1);
  while (pending.length > 0) {
    const envToken = stripSurroundingQuotes(pending.shift() ?? "");
    if (!envToken) {
      continue;
    }

    const inlineSplitValue = extractEnvInlineSplitStringValue(envToken);
    if (inlineSplitValue) {
      const expanded = parseSystemdExecStart(stripSurroundingQuotes(inlineSplitValue));
      if (expanded.length > 0) {
        pending.unshift(...expanded);
      }
      continue;
    }

    if (envOptionConsumesNextValue(envToken)) {
      const optionValue = pending.shift() ?? "";
      if ((envToken === "-S" || envToken === "--split-string") && optionValue) {
        const expanded = parseSystemdExecStart(stripSurroundingQuotes(optionValue));
        if (expanded.length > 0) {
          pending.unshift(...expanded);
        }
      }
      continue;
    }

    // Handle clustered short options (e.g. -iu VAR, -i0C DIR, -iS "cmd").
    const cluster = parseEnvShortOptionCluster(envToken);
    if (cluster) {
      if (cluster.consumesNext) {
        const optionValue = pending.shift() ?? "";
        if (cluster.isSplitString && optionValue) {
          const expanded = parseSystemdExecStart(stripSurroundingQuotes(optionValue));
          if (expanded.length > 0) {
            pending.unshift(...expanded);
          }
        }
      } else if (cluster.inlineValue && cluster.isSplitString) {
        const expanded = parseSystemdExecStart(stripSurroundingQuotes(cluster.inlineValue));
        if (expanded.length > 0) {
          pending.unshift(...expanded);
        }
      }
      continue;
    }

    if (envToken.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(envToken)) {
      continue;
    }

    // Found the real command.
    const command = stripSystemdExecPrefix(envToken);
    return {
      command: command || null,
      args: pending.map(stripSurroundingQuotes),
    };
  }

  return { command: null, args: [] };
}

function isEnvCommandToken(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === "env" || lower.endsWith("/env");
}

export function extractSystemdExecStartCommandToken(execStartValue: string): string | null {
  return resolveExecStartCommand(execStartValue).command;
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
