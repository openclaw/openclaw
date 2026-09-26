/** Classify captured service commands without treating display names as execution evidence. */
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRootOptionAwareCommandPath } from "../infra/cli-root-options.js";
import { isEnvAssignmentToken, resolveCarrierCommandArgv } from "../infra/command-carriers.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import { POSIX_SHELL_WRAPPERS } from "../infra/shell-wrapper-resolution.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { parseCmdSetAssignment } from "./cmd-set.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayWindowsTaskName,
} from "./constants.js";
import { resolveGeneratedEnvWrapperLayout } from "./launchd-plist.js";
import { resolveRuntimeScriptPosition } from "./runtime-binary.js";
import {
  parseSystemdInlineEnvironment,
  parseSystemdExecStart,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

export const EXTRA_MARKERS = ["openclaw", "clawdbot"] as const;

export type Marker = (typeof EXTRA_MARKERS)[number];

export function hasGatewaySubcommandArg(programArguments: string[]): boolean {
  let args =
    resolveCarrierCommandArgv(programArguments, 0, { includeExec: true }) ?? programArguments;
  if (POSIX_SHELL_WRAPPERS.has(path.posix.basename(args[0] ?? "").toLowerCase())) {
    const { command } = resolveInlineCommandMatch(args, POSIX_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
    });
    const inner = command ? splitShellArgs(command) : null;
    if (!inner) {
      return false;
    }
    while (inner.length > 0 && isEnvAssignmentToken(inner[0]!)) {
      inner.shift();
    }
    args = resolveCarrierCommandArgv(inner, 0, { includeExec: true }) ?? inner;
  }
  args = resolveCarrierCommandArgv(args, 0, { includeExec: true }) ?? args;
  const position = resolveRuntimeScriptPosition(args);
  if (typeof position !== "number" && position.kind !== "not-runtime") {
    return false;
  }
  const entryIndex = typeof position === "number" ? position : 0;
  return getRootOptionAwareCommandPath(["node", ...args.slice(entryIndex)], 1)[0] === "gateway";
}

export function detectMarkerLineWithGateway(contents: string): Marker | null {
  // Use the same physical-comment rules as service rewrites; comments must not
  // hide a runnable extra service from diagnostics.
  for (const line of splitSystemdLogicalLines(contents)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const assignment = trimmed.indexOf("=");
    if (assignment > 0) {
      const key = normalizeLowercaseStringOrEmpty(trimmed.slice(0, assignment));
      if (
        key !== "execstart" ||
        !hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim()))
      ) {
        continue;
      }
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (!normalized.includes("gateway")) {
      continue;
    }
    for (const marker of EXTRA_MARKERS) {
      if (normalized.includes(marker)) {
        return marker;
      }
    }
  }
  return null;
}

export function hasGatewayServiceMarker(value: unknown): boolean {
  const environment = asOptionalRecord(value);
  return (
    environment?.OPENCLAW_SERVICE_MARKER === GATEWAY_SERVICE_MARKER &&
    environment.OPENCLAW_SERVICE_KIND === GATEWAY_SERVICE_KIND
  );
}

export function hasSystemdGatewayServiceMarker(content: string): boolean {
  return hasGatewayServiceMarker(parseSystemdInlineEnvironment(content));
}

export function detectLaunchdGatewayExecutionMarker(plist: Record<string, unknown>): Marker | null {
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    return null;
  }
  if (plist.Program !== undefined && typeof plist.Program !== "string") {
    return null;
  }
  const programArguments =
    typeof plist.Program === "string" ? [plist.Program, ...args.slice(1)] : args;
  const layout = resolveGeneratedEnvWrapperLayout(programArguments);
  const command = layout ? programArguments.slice(layout.commandStartIndex) : programArguments;
  if (!hasGatewaySubcommandArg(command)) {
    return null;
  }
  // Only execution command fields identify gateway jobs; labels alone catch too
  // many unrelated helper jobs.
  const launchCommand = normalizeLowercaseStringOrEmpty(command.join("\n"));
  return EXTRA_MARKERS.find((marker) => launchCommand.includes(marker)) ?? null;
}

export function isOpenClawGatewaySystemdService(name: string, contents: string): boolean {
  if (hasSystemdGatewayServiceMarker(contents)) {
    return true;
  }
  if (!name.startsWith("openclaw-gateway")) {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(contents).includes("gateway");
}

export function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  if (!normalized) {
    return false;
  }
  // Windows schtasks /Query returns task names prefixed with \ (e.g.
  // \OpenClaw Gateway for root-folder tasks). Strip the leading
  // backslash so the configured name matches correctly and the live
  // gateway task is not misidentified as an extra gateway service.
  const stripped = normalized.replace(/^\\+/, "");
  const defaultName = normalizeLowercaseStringOrEmpty(resolveGatewayWindowsTaskName());
  return stripped === defaultName || /^openclaw gateway \(.+\)$/.test(stripped);
}

export function detectWindowsServiceExecutionMarker(args: string[], cwd?: string): Marker | null {
  if (
    classifyOpenClawArgv(args, { command: "gateway", cwd }).kind === "openclaw" ||
    classifyOpenClawArgv(args, { command: "node", cwd }).kind === "openclaw"
  ) {
    return "openclaw";
  }
  const command = normalizeLowercaseStringOrEmpty(args.join("\n"));
  if (command.includes("clawdbot")) {
    return "clawdbot";
  }
  return command.includes("openclaw") &&
    args.some((arg) => /^(?:gateway|node)$/.test(normalizeLowercaseStringOrEmpty(arg)))
    ? "openclaw"
    : null;
}

export function detectLauncherGatewayMarker(contents: string): Marker | null {
  const environment: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const command = normalizeLowercaseStringOrEmpty(line.trim());
    if (command.startsWith("set ")) {
      const assignment = parseCmdSetAssignment(line.trimStart().slice(4), true);
      if (assignment) {
        environment[assignment.key] = assignment.value;
      }
      continue;
    }
    if (/^(?:#|;|'|rem\s)/.test(command) || !command.includes("gateway")) {
      continue;
    }
    const marker = EXTRA_MARKERS.find((candidate) => command.includes(candidate));
    if (marker) {
      return marker;
    }
  }
  return hasGatewayServiceMarker(environment) ? "openclaw" : null;
}
