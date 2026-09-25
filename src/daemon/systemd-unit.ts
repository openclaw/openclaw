/** Renders and parses systemd unit snippets for managed gateway services. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { escape as escapeGlob } from "minimatch";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

const SYSTEMD_LINE_BREAKS = /[\r\n]/;

/** Copy only policy fields admitted for preservation by the native audit. */
export function preserveSystemdUnitPolicy(
  generated: string,
  previous: string,
  keys: readonly string[] = [],
): string {
  if (!keys.length) {
    return generated;
  }
  const keyedLines = (content: string) => {
    let section = "";
    return splitSystemdLogicalLines(content).map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        section = trimmed.slice(1, -1);
      }
      const separator = trimmed.indexOf("=");
      return { line, key: separator < 0 ? "" : `${section}.${trimmed.slice(0, separator).trim()}` };
    });
  };
  const installed = keyedLines(previous);
  const retained = new Map(keys.map((key) => [key, installed.filter((line) => line.key === key)]));
  const copied = new Set<string>();
  return `${keyedLines(generated)
    .flatMap(({ line, key }) => {
      const original = retained.get(key);
      if (!original) {
        return [line];
      }
      if (!original.length) {
        throw new Error(`Custom systemd policy ${key} disappeared before publication.`);
      }
      if (copied.has(key)) {
        return [];
      }
      copied.add(key);
      return original.map((entry) => entry.line);
    })
    .join("\n")
    .trimEnd()}\n`;
}

export const SYSTEMD_FIXED_POLICY: Readonly<Record<string, string>> = {
  "Unit.After": "network-online.target",
  "Unit.Wants": "network-online.target",
  // Ten starts cover the five-minute lifecycle ownership wait without crash loops.
  "Unit.StartLimitBurst": "10",
  "Unit.StartLimitIntervalSec": "300",
  "Service.Restart": "always",
  "Service.RestartSec": "5",
  "Service.RestartPreventExitStatus": "78",
  // Include the Gateway drain, teardown reserve, and supervisor exit margin.
  "Service.TimeoutStopSec": String(GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000),
  "Service.TimeoutStartSec": "30",
  "Service.SuccessExitStatus": "0 143",
  // An OOM-killed child must not take down the Gateway that supervises it.
  "Service.OOMPolicy": "continue",
  // Signal only the Gateway during drain; clean up children after it exits.
  "Service.KillMode": "mixed",
  "Install.WantedBy": "default.target",
};

function renderFixedPolicy(section: string): string[] {
  return Object.entries(SYSTEMD_FIXED_POLICY)
    .filter(([key]) => key.startsWith(`${section}.`))
    .map(([key, value]) => `${key.slice(section.length + 1)}=${value}`);
}

/** Keep installed launch arguments and environment while migrating installer policy. */
export function refreshSystemdUnitPolicy(content: string): string {
  const lines: string[] = [];
  const sections = new Set<string>();
  let section = "";
  for (const raw of splitSystemdLogicalLines(content)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      lines.push(...renderFixedPolicy(section));
      section = line.slice(1, -1);
      sections.add(section);
    }
    const separator = line.indexOf("=");
    if (
      separator > 0 &&
      Object.hasOwn(SYSTEMD_FIXED_POLICY, `${section}.${line.slice(0, separator).trim()}`)
    ) {
      continue;
    }
    lines.push(raw);
  }
  lines.push(...renderFixedPolicy(section));
  for (const name of new Set(Object.keys(SYSTEMD_FIXED_POLICY).map((key) => key.split(".")[0]!))) {
    if (!sections.has(name)) {
      lines.push(`[${name}]`, ...renderFixedPolicy(name));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

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
  // systemd ExecStart/Environment parsing consumes one backslash before the next
  // character, so every backslash and quote must be escaped for the value to
  // survive the round-trip byte-for-byte. Escaping only backslash pairs left a
  // lone backslash unescaped, and the reader then swallowed the byte after it.
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function renderEnvLines(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) {
    return [];
  }
  // An explicit empty NODE_OPTIONS blocks inherited supervisor preload/heap flags.
  const entries = Object.entries(env).filter(
    ([key, value]) => typeof value === "string" && (value.trim() || key === "NODE_OPTIONS"),
  );
  return entries.map(([key, value]) => {
    const rawValue = value ?? "";
    assertNoSystemdLineBreaks(key, "Systemd environment variable names");
    assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
    const assignment = `${key}=${rawValue.trim()}`.replaceAll("%", "%%");
    return `Environment=${systemdEscapeArg(assignment)}`;
  });
}

export function renderSystemdEnvironmentFile(entry: string): string {
  assertNoSystemdLineBreaks(entry, "Systemd EnvironmentFile values");
  // EnvironmentFile is one scalar glob, not a quoted argv word.
  return `-${escapeGlob(entry).replaceAll("%", "%%")}`;
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
  environmentFiles,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments
    .map((argument) => systemdEscapeArg(argument.replaceAll("%", "%%")))
    .join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
  const descriptionLine = `Description=${descriptionValue}`;
  if (workingDirectory) {
    assertNoSystemdLineBreaks(workingDirectory, "Systemd WorkingDirectory");
    const lastComponent = workingDirectory
      .split("/")
      .findLast((part) => part !== "" && part !== ".");
    // systemd 255 strips trailing whitespace when serializing cwd to its executor.
    // Check the last real component without normalizing symlink-sensitive parent segments.
    if (lastComponent && /[ \t]$/u.test(lastComponent)) {
      throw new Error(
        "Systemd WorkingDirectory cannot end in spaces or tabs; choose a directory without trailing whitespace.",
      );
    }
  }
  // Scalar paths are unquoted; /. shields a final backslash from line continuation.
  const workingDirPath = workingDirectory?.replace(/\\$/u, "$&/.");
  const workingDirLine = workingDirPath
    ? `WorkingDirectory=${workingDirPath.replaceAll("%", "%%")}`
    : null;
  const envLines = renderEnvLines(environment);
  return [
    "[Unit]",
    descriptionLine,
    ...renderFixedPolicy("Unit"),
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    ...renderFixedPolicy("Service"),
    workingDirLine,
    ...normalizeStringEntries(environmentFiles).map(
      (entry) => `EnvironmentFile=${renderSystemdEnvironmentFile(entry)}`,
    ),
    ...envLines,
    "",
    "[Install]",
    ...renderFixedPolicy("Install"),
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function parseSystemdExecStart(value: string): string[] {
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}

export function splitSystemdEnvironmentWords(value: string): string[] {
  return splitArgsPreservingQuotes(value, {
    escapeMode: "backslash",
    quoteChars: ['"', "'"],
    quoteStart: "item-start",
  });
}

export function parseSystemdEnvAssignments(raw: string): Array<{ key: string; value: string }> {
  return splitSystemdEnvironmentWords(raw).flatMap((entry) => {
    // The splitter has already removed quotes and consumed escapes.
    const assignment = entry.trim();
    const separator = assignment.indexOf("=");
    return separator <= 0
      ? []
      : [{ key: assignment.slice(0, separator).trim(), value: assignment.slice(separator + 1) }];
  });
}

export function splitSystemdLogicalLines(content: string): string[] {
  const lines: string[] = [];
  let continued = "";
  for (const physicalLine of content.split(/\r?\n/)) {
    // systemd skips physical comments before continuation handling. Keep standalone
    // comments for unit rewrites, but never let their backslashes consume directives.
    if (/^\s*[#;]/u.test(physicalLine)) {
      if (!continued) {
        lines.push(physicalLine);
      }
      continue;
    }
    const line = continued + physicalLine;
    // Only an unmatched final backslash continues; indentation inside quotes is data.
    if (/(?:^|[^\\])(?:\\\\)*\\$/u.test(line)) {
      continued = `${line.slice(0, -1)} `;
    } else {
      lines.push(line);
      continued = "";
    }
  }
  return continued ? [...lines, continued] : lines;
}

export function renderSystemdEnvAssignment(key: string, value: string): string {
  return systemdEscapeArg(`${key}=${value}`);
}
