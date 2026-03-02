import fs from "node:fs";
import path from "node:path";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import { resolveDispatchWrapperExecutionPlan } from "./exec-wrapper-resolution.js";
import { resolveExecutablePath as resolveExecutableCandidatePath } from "./executable-path.js";
import { expandHomePrefix } from "./home-dir.js";

export const DEFAULT_SAFE_BINS = ["jq", "cut", "uniq", "head", "tail", "tr", "wc"];

export type CommandResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};

function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) {
      return trimmed.slice(1, end);
    }
    return trimmed.slice(1);
  }
  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

function tryResolveRealpath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function buildCommandResolution(params: {
  rawExecutable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  effectiveArgv: string[];
  wrapperChain: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
}): CommandResolution {
  const resolvedPath = resolveExecutableCandidatePath(params.rawExecutable, {
    cwd: params.cwd,
    env: params.env,
  });
  const resolvedRealPath = tryResolveRealpath(resolvedPath);
  const executableName = resolvedPath ? path.basename(resolvedPath) : params.rawExecutable;
  return {
    rawExecutable: params.rawExecutable,
    resolvedPath,
    resolvedRealPath,
    executableName,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
}

export function resolveCommandResolution(
  command: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = parseFirstToken(command);
  if (!rawExecutable) {
    return null;
  }
  return buildCommandResolution({
    rawExecutable,
    effectiveArgv: [rawExecutable],
    wrapperChain: [],
    policyBlocked: false,
    cwd,
    env,
  });
}

export function resolveCommandResolutionFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const plan = resolveDispatchWrapperExecutionPlan(argv);
  const effectiveArgv = plan.argv;
  const rawExecutable = effectiveArgv[0]?.trim();
  if (!rawExecutable) {
    return null;
  }
  return buildCommandResolution({
    rawExecutable,
    effectiveArgv,
    wrapperChain: plan.wrappers,
    policyBlocked: plan.policyBlocked,
    blockedWrapper: plan.blockedWrapper,
    cwd,
    env,
  });
}

export function resolveAllowlistCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  if (!resolution) {
    return undefined;
  }
  if (resolution.resolvedPath) {
    return resolution.resolvedPath;
  }
  const raw = resolution.rawExecutable?.trim();
  if (!raw) {
    return undefined;
  }
  const expanded = raw.startsWith("~") ? expandHomePrefix(raw) : raw;
  if (!expanded.includes("/") && !expanded.includes("\\")) {
    return undefined;
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  return path.resolve(base, expanded);
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: CommandResolution | null,
): ExecAllowlistEntry | null {
  if (!entries.length) {
    return null;
  }
  // A bare "*" wildcard allows any parsed executable command.
  // Check it before the resolvedPath guard so unresolved PATH lookups still
  // match (for example platform-specific executables without known extensions).
  const bareWild = entries.find((e) => e.pattern?.trim() === "*");
  if (bareWild && resolution) {
    return bareWild;
  }
  if (!resolution?.resolvedPath) {
    return null;
  }
  const resolvedPath = resolution.resolvedPath;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
    if (!hasPath) {
      continue;
    }
    if (matchesExecAllowlistPattern(pattern, resolvedPath)) {
      return entry;
    }
  }
  return null;
}

export type ExecArgvToken =
  | {
      kind: "empty";
      raw: string;
    }
  | {
      kind: "terminator";
      raw: string;
    }
  | {
      kind: "stdin";
      raw: string;
    }
  | {
      kind: "positional";
      raw: string;
    }
  | {
      kind: "option";
      raw: string;
      style: "long";
      flag: string;
      inlineValue?: string;
    }
  | {
      kind: "option";
      raw: string;
      style: "short-cluster";
      cluster: string;
      flags: string[];
    };

/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
export function parseExecArgvToken(raw: string): ExecArgvToken {
  if (!raw) {
    return { kind: "empty", raw };
  }
  if (raw === "--") {
    return { kind: "terminator", raw };
  }
  if (raw === "-") {
    return { kind: "stdin", raw };
  }
  if (!raw.startsWith("-")) {
    return { kind: "positional", raw };
  }
  if (raw.startsWith("--")) {
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 0) {
      return {
        kind: "option",
        raw,
        style: "long",
        flag: raw.slice(0, eqIndex),
        inlineValue: raw.slice(eqIndex + 1),
      };
    }
    return { kind: "option", raw, style: "long", flag: raw };
  }
  const cluster = raw.slice(1);
  return {
    kind: "option",
    raw,
    style: "short-cluster",
    cluster,
    flags: cluster.split("").map((entry) => `-${entry}`),
  };
}
