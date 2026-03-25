import fs from "node:fs";
import path from "node:path";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { resolveExecutablePath as resolveExecutableCandidatePath } from "./executable-path.js";
import { expandHomePrefix } from "./home-dir.js";

export type ExecutableResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
};

export type CommandResolution = {
  execution: ExecutableResolution;
  policy: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};

function isCommandResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): resolution is CommandResolution {
  return Boolean(resolution && "execution" in resolution && "policy" in resolution);
}

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

function buildExecutableResolution(
  rawExecutable: string,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): ExecutableResolution {
  const resolvedPath = resolveExecutableCandidatePath(rawExecutable, {
    cwd: params.cwd,
    env: params.env,
  });
  const resolvedRealPath = tryResolveRealpath(resolvedPath);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return {
    rawExecutable,
    resolvedPath,
    resolvedRealPath,
    executableName,
  };
}

function buildCommandResolution(params: {
  rawExecutable: string;
  policyRawExecutable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  effectiveArgv: string[];
  wrapperChain: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
}): CommandResolution {
  const execution = buildExecutableResolution(params.rawExecutable, params);
  const policy = params.policyRawExecutable
    ? buildExecutableResolution(params.policyRawExecutable, params)
    : execution;
  const resolution: CommandResolution = {
    execution,
    policy,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
  // Compatibility getters for JS/tests while TS callers migrate to explicit targets.
  return Object.defineProperties(resolution, {
    rawExecutable: {
      get: () => execution.rawExecutable,
    },
    resolvedPath: {
      get: () => execution.resolvedPath,
    },
    resolvedRealPath: {
      get: () => execution.resolvedRealPath,
    },
    executableName: {
      get: () => execution.executableName,
    },
    policyResolution: {
      get: () => (policy === execution ? undefined : policy),
    },
  });
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
  const plan = resolveExecWrapperTrustPlan(argv);
  const effectiveArgv = plan.argv;
  const rawExecutable = effectiveArgv[0]?.trim();
  if (!rawExecutable) {
    return null;
  }
  return buildCommandResolution({
    rawExecutable,
    policyRawExecutable: plan.policyArgv[0]?.trim(),
    effectiveArgv,
    wrapperChain: plan.wrapperChain,
    policyBlocked: plan.policyBlocked,
    blockedWrapper: plan.blockedWrapper,
    cwd,
    env,
  });
}

function resolveExecutableCandidatePathFromResolution(
  resolution: ExecutableResolution | null | undefined,
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

export function resolveExecutionTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return isCommandResolution(resolution) ? resolution.execution : resolution;
}

export function resolvePolicyTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return isCommandResolution(resolution) ? resolution.policy : resolution;
}

export function resolveExecutionTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    isCommandResolution(resolution) ? resolution.execution : resolution,
    cwd,
  );
}

export function resolvePolicyTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    isCommandResolution(resolution) ? resolution.policy : resolution,
    cwd,
  );
}

export function resolveApprovalAuditCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetCandidatePath(resolution, cwd);
}

// Legacy alias kept while callers migrate to explicit target naming.
export function resolveAllowlistCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutionTargetCandidatePath(resolution, cwd);
}

export function resolvePolicyAllowlistCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetCandidatePath(resolution, cwd);
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: ExecutableResolution | null,
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
