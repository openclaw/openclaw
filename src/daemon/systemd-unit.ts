import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

const SYSTEMD_LINE_BREAKS = /[\r\n]/;

/**
 * Filename for the OpenClaw-owned drop-in that carries managed environment
 * variables. The drop-in is written into `<unit>.d/` next to the main unit so
 * systemd composes it automatically at load time. Keeping managed env out of
 * the main unit lets user-added `EnvironmentFile=`/`Environment=` directives
 * survive upgrades that regenerate the managed state.
 */
export const OPENCLAW_MANAGED_DROPIN_FILENAME = "openclaw-managed.conf";

/**
 * Env var that tracks which keys in the managed drop-in (or, for legacy units,
 * inline in the main unit) are OpenClaw-owned. Mirrors the constant in
 * `src/commands/daemon-install-helpers.ts`; duplicated here to keep
 * `systemd-unit.ts` free of cross-module imports.
 */
export const OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR = "OPENCLAW_SERVICE_MANAGED_ENV_KEYS";

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

function renderEnvironmentFileLines(environmentFiles: string[] | undefined): string[] {
  if (!environmentFiles) {
    return [];
  }
  return environmentFiles
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      assertNoSystemdLineBreaks(entry, "Systemd EnvironmentFile values");
      return `EnvironmentFile=-${systemdEscapeArg(entry)}`;
    });
}

function parseManagedKeyList(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  const keys = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalized = entry.trim().toUpperCase();
    if (normalized) {
      keys.add(normalized);
    }
  }
  return keys;
}

/**
 * Split an environment dict into managed and user partitions based on the
 * `OPENCLAW_SERVICE_MANAGED_ENV_KEYS` sentinel. Managed keys (plus the sentinel
 * itself) belong in the drop-in; everything else belongs in the main unit so
 * user-added entries survive regeneration.
 *
 * If the sentinel is absent, all env is treated as user-owned — the caller
 * gets back `{ managed: {}, user: environment }` and no drop-in gets written.
 */
export function splitSystemdManagedEnvironment(
  environment: Record<string, string | undefined> | undefined,
): {
  managed: Record<string, string | undefined>;
  user: Record<string, string | undefined>;
} {
  if (!environment) {
    return { managed: {}, user: {} };
  }
  const sentinelValue = environment[OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR];
  const managedKeys = parseManagedKeyList(sentinelValue ?? undefined);
  if (managedKeys.size === 0) {
    return { managed: {}, user: { ...environment } };
  }
  const managed: Record<string, string | undefined> = {};
  const user: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(environment)) {
    const upper = key.toUpperCase();
    if (upper === OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR || managedKeys.has(upper)) {
      managed[key] = value;
      continue;
    }
    user[key] = value;
  }
  return { managed, user };
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
  environmentFiles,
}: GatewayServiceRenderArgs): string {
  // Main-unit rendering excludes managed env — the managed drop-in carries it
  // now so user customizations in the main unit survive openclaw update.
  const { user } = splitSystemdManagedEnvironment(environment);
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
  const descriptionLine = `Description=${descriptionValue}`;
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const environmentFileLines = renderEnvironmentFileLines(environmentFiles);
  const envLines = renderEnvLines(user);
  return [
    "[Unit]",
    descriptionLine,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitBurst=5",
    "StartLimitIntervalSec=60",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    "TimeoutStopSec=30",
    "TimeoutStartSec=30",
    "SuccessExitStatus=0 143",
    // Keep service children in the same lifecycle so restarts do not leave
    // orphan ACP/runtime workers behind.
    "KillMode=control-group",
    workingDirLine,
    ...environmentFileLines,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Render the OpenClaw-managed drop-in text. Contains only the `[Service]`
 * section with `Environment=` lines for managed keys, plus a header comment
 * flagging the file as auto-managed so users know not to hand-edit it.
 *
 * Returns an empty string when there is nothing to manage, so callers can skip
 * writing the drop-in entirely in that case.
 */
export function buildSystemdManagedDropIn(
  environment: Record<string, string | undefined> | undefined,
): string {
  const { managed } = splitSystemdManagedEnvironment(environment);
  const envLines = renderEnvLines(managed);
  if (envLines.length === 0) {
    return "";
  }
  return [
    "# Auto-managed by openclaw. Do not edit — customizations belong in the main unit.",
    "# See https://github.com/openclaw/openclaw/issues/66248 for background.",
    "",
    "[Service]",
    ...envLines,
    "",
  ].join("\n");
}

/**
 * Strip inline managed env from existing main-unit text while preserving
 * everything else (comments, blank lines, user `Environment=`, `EnvironmentFile=`,
 * and non-`[Service]` sections). Used by `openclaw update` to migrate legacy
 * units that have managed env inline into the new drop-in layout without
 * touching user customizations in the same file.
 *
 * Lines removed:
 *   - `Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=...` (the sentinel)
 *   - `Environment=<KEY>=...` for every KEY listed in the sentinel's value
 *
 * Lines kept untouched:
 *   - `EnvironmentFile=...`
 *   - `Environment=` lines for keys not in the sentinel
 *   - `[Unit]`, `[Service]`, `[Install]` headers
 *   - Blank lines and comments
 *   - Any other directive
 */
export function stripManagedEnvFromSystemdUnit(text: string): string {
  const lines = text.split("\n");
  let managedKeys: Set<string> | null = null;

  // First pass: locate the sentinel line to discover what's managed.
  for (const rawLine of lines) {
    const parsed = parseEnvironmentDirectiveLine(rawLine);
    if (!parsed) {
      continue;
    }
    for (const assignment of parsed.assignments) {
      if (assignment.key.toUpperCase() === OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR) {
        managedKeys = parseManagedKeyList(assignment.value);
        break;
      }
    }
    if (managedKeys) {
      break;
    }
  }

  if (!managedKeys || managedKeys.size === 0) {
    // Nothing to strip — no sentinel means no inline managed state.
    return text;
  }

  return stripEnvironmentAssignments(
    text,
    (assignment) =>
      assignment.key.toUpperCase() === OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR ||
      managedKeys.has(assignment.key.toUpperCase()),
  );
}

export function stripEnvironmentKeysFromSystemdUnit(text: string, keys: Iterable<string>): string {
  const normalizedKeys = new Set(Array.from(keys, (key) => key.toUpperCase()));
  if (normalizedKeys.size === 0) {
    return text;
  }
  return stripEnvironmentAssignments(text, (assignment) =>
    normalizedKeys.has(assignment.key.toUpperCase()),
  );
}

function stripEnvironmentAssignments(
  text: string,
  shouldStrip: (assignment: { key: string; value: string }) => boolean,
): string {
  const lines = text.split("\n");
  const filtered: string[] = [];
  for (const rawLine of lines) {
    const parsed = parseEnvironmentDirectiveLine(rawLine);
    if (parsed) {
      const kept = parsed.assignments.filter((assignment) => !shouldStrip(assignment));
      if (kept.length === 0) {
        continue;
      }
      if (kept.length !== parsed.assignments.length) {
        filtered.push(
          ...renderEnvLines(Object.fromEntries(kept.map(({ key, value }) => [key, value]))).map(
            (line) => `${parsed.leadingWhitespace}${line}`,
          ),
        );
        continue;
      }
    }
    filtered.push(rawLine);
  }
  return filtered.join("\n");
}

/**
 * Replace the `ExecStart=` line in an existing unit, preserving all other
 * content. Returns the original text unchanged if no `ExecStart=` line is
 * found (caller should treat that as a corrupt unit and rewrite from scratch).
 *
 * Used by `openclaw update` to propagate entry-filename bumps across versions
 * without wiping user customizations elsewhere in the main unit.
 */
export function updateExecStartInSystemdUnit(
  text: string,
  programArguments: readonly string[],
): { text: string; updated: boolean; found: boolean } {
  const newExecStart = `ExecStart=${programArguments.map(systemdEscapeArg).join(" ")}`;
  const lines = text.split("\n");
  let updated = false;
  let found = false;
  const next = lines.map((line) => {
    if (!line.trimStart().startsWith("ExecStart=")) {
      return line;
    }
    found = true;
    if (line === newExecStart) {
      return line;
    }
    updated = true;
    const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";
    return `${leadingWhitespace}${newExecStart}`;
  });
  return { text: next.join("\n"), updated, found };
}

function resolveServiceSectionBounds(
  lines: readonly string[],
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === "[Service]");
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (trimmed?.startsWith("[") && trimmed.endsWith("]")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function findServiceDirectiveIndex(
  lines: readonly string[],
  bounds: { start: number; end: number },
  directive: string,
): number {
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    if (lines[index]?.trimStart().startsWith(`${directive}=`)) {
      return index;
    }
  }
  return -1;
}

export function updateWorkingDirectoryInSystemdUnit(
  text: string,
  workingDirectory?: string,
): { text: string; updated: boolean } {
  const lines = text.split("\n");
  const serviceBounds = resolveServiceSectionBounds(lines);
  if (!serviceBounds) {
    return { text, updated: false };
  }

  const workingDirectoryIndex = findServiceDirectiveIndex(lines, serviceBounds, "WorkingDirectory");
  const nextLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : undefined;

  if (workingDirectoryIndex >= 0) {
    if (!nextLine) {
      lines.splice(workingDirectoryIndex, 1);
      return { text: lines.join("\n"), updated: true };
    }
    if (lines[workingDirectoryIndex] === nextLine) {
      return { text, updated: false };
    }
    const leadingWhitespace = lines[workingDirectoryIndex]?.match(/^\s*/)?.[0] ?? "";
    lines[workingDirectoryIndex] = `${leadingWhitespace}${nextLine}`;
    return { text: lines.join("\n"), updated: true };
  }

  if (!nextLine) {
    return { text, updated: false };
  }

  const killModeIndex = findServiceDirectiveIndex(lines, serviceBounds, "KillMode");
  const execStartIndex = findServiceDirectiveIndex(lines, serviceBounds, "ExecStart");
  const insertAfter =
    killModeIndex >= 0 ? killModeIndex : execStartIndex >= 0 ? execStartIndex : serviceBounds.start;
  lines.splice(insertAfter + 1, 0, nextLine);
  return { text: lines.join("\n"), updated: true };
}

export function updateEnvironmentFilesInSystemdUnit(
  text: string,
  environmentFiles: readonly string[],
): { text: string; updated: boolean } {
  const environmentFileLines = renderEnvironmentFileLines([...environmentFiles]);
  if (environmentFileLines.length === 0) {
    return { text, updated: false };
  }

  const lines = text.split("\n");
  const serviceBounds = resolveServiceSectionBounds(lines);
  if (!serviceBounds) {
    return { text, updated: false };
  }

  const missingLines = environmentFileLines.filter((line) => !lines.includes(line));
  if (missingLines.length === 0) {
    return { text, updated: false };
  }

  const workingDirectoryIndex = findServiceDirectiveIndex(lines, serviceBounds, "WorkingDirectory");
  const killModeIndex = findServiceDirectiveIndex(lines, serviceBounds, "KillMode");
  const execStartIndex = findServiceDirectiveIndex(lines, serviceBounds, "ExecStart");
  const insertAfter =
    workingDirectoryIndex >= 0
      ? workingDirectoryIndex
      : killModeIndex >= 0
        ? killModeIndex
        : execStartIndex >= 0
          ? execStartIndex
          : serviceBounds.start;
  lines.splice(insertAfter + 1, 0, ...missingLines);
  return { text: lines.join("\n"), updated: true };
}

function parseEnvironmentDirectiveLine(
  rawLine: string,
): { assignments: Array<{ key: string; value: string }>; leadingWhitespace: string } | null {
  const leadingWhitespace = rawLine.match(/^\s*/)?.[0] ?? "";
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("Environment=")) {
    return null;
  }
  const raw = trimmed.slice("Environment=".length).trim();
  const assignments = parseSystemdEnvAssignments(raw);
  return assignments.length > 0 ? { assignments, leadingWhitespace } : null;
}

export function parseSystemdExecStart(value: string): string[] {
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}

function parseSystemdEnvAssignmentToken(token: string): { key: string; value: string } | null {
  const eq = token.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = token.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const value = token.slice(eq + 1);
  return { key, value };
}

export function parseSystemdEnvAssignments(raw: string): Array<{ key: string; value: string }> {
  return splitArgsPreservingQuotes(raw, { escapeMode: "backslash" })
    .map(parseSystemdEnvAssignmentToken)
    .filter((assignment): assignment is { key: string; value: string } => assignment !== null);
}

export function parseSystemdEnvAssignment(raw: string): { key: string; value: string } | null {
  return parseSystemdEnvAssignments(raw)[0] ?? null;
}
