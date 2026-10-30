import crypto from "node:crypto";
import path from "node:path";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { compileExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import {
  resolveExecutablePath as resolveExecutableCandidatePath,
  resolveExecutablePathCandidate,
} from "./executable-path.js";

export type ExecutableResolution = {
  kind: "executable";
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
};

export type CommandResolution = {
  kind: "command";
  execution: ExecutableResolution;
  policy: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};

function tryResolveRealpath(filePath: string | undefined): string | undefined {
  return filePath ? (safeRealpathSync(filePath) ?? undefined) : undefined;
}

function buildExecutableResolution(
  rawExecutable: string,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    useCache?: boolean;
  },
): ExecutableResolution {
  const resolvedPath = resolveExecutableCandidatePath(rawExecutable, params);
  const resolvedRealPath = tryResolveRealpath(resolvedPath);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return {
    kind: "executable",
    rawExecutable,
    resolvedPath,
    resolvedRealPath,
    executableName,
  };
}

export function resolveCommandResolutionFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options?: { useCache?: boolean },
): CommandResolution | null {
  const plan = resolveExecWrapperTrustPlan(argv, undefined, platform);
  const effectiveArgv = plan.argv;
  const rawExecutable = effectiveArgv[0]?.trim();
  if (!rawExecutable) {
    return null;
  }
  const resolutionOptions = { cwd, env, useCache: options?.useCache };
  const execution = buildExecutableResolution(rawExecutable, resolutionOptions);
  const policyRawExecutable = plan.policyArgv[0]?.trim();
  return {
    kind: "command",
    execution,
    policy: policyRawExecutable
      ? buildExecutableResolution(policyRawExecutable, resolutionOptions)
      : execution,
    effectiveArgv,
    wrapperChain: plan.wrapperChain,
    policyBlocked: plan.policyBlocked,
    blockedWrapper: plan.blockedWrapper,
  };
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
  return resolveExecutablePathCandidate(raw, {
    cwd,
    requirePathSeparator: true,
  });
}

export function resolveExecutableTrustPath(
  resolution: ExecutableResolution | null | undefined,
  cwd?: string,
): string | undefined {
  const realPath = resolution?.resolvedRealPath?.trim();
  if (realPath) {
    return realPath;
  }
  const candidatePath = resolveExecutableCandidatePathFromResolution(resolution, cwd);
  return tryResolveRealpath(candidatePath) ?? candidatePath;
}

export function resolveExecutionTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  return resolution?.kind === "command" ? resolution.execution : (resolution ?? null);
}

export function resolvePolicyTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  return resolution?.kind === "command" ? resolution.policy : (resolution ?? null);
}

export function resolveExecutionTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    resolveExecutionTargetResolution(resolution),
    cwd,
  );
}

export function resolveExecutionTargetTrustPath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableTrustPath(resolveExecutionTargetResolution(resolution), cwd);
}

export function resolvePolicyTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    resolvePolicyTargetResolution(resolution),
    cwd,
  );
}

export function resolvePolicyTargetTrustPath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableTrustPath(resolvePolicyTargetResolution(resolution), cwd);
}

export function resolveApprovalAuditTrustPath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetTrustPath(resolution, cwd);
}

const LEGACY_HASHED_ARG_PATTERN_PREFIX = "sha256:argv:";
const CWD_BOUND_HASHED_ARG_PATTERN_PREFIX = "sha256:cwd-argv:v1:";

export function isGeneratedHashedArgPattern(value: string | null | undefined): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(CWD_BOUND_HASHED_ARG_PATTERN_PREFIX) ||
      value.startsWith(LEGACY_HASHED_ARG_PATTERN_PREFIX))
  );
}

export function isCwdBoundHashedArgPattern(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CWD_BOUND_HASHED_ARG_PATTERN_PREFIX);
}

export function classifyExecAllowlistScope(
  entry: Pick<ExecAllowlistEntry, "pattern" | "source" | "argPattern">,
): "command text" | "argv+cwd" | "argv" | "any args" | "inactive" {
  const pattern = entry.pattern.trim();
  const generated = entry.source === "allow-always";
  // Reserved command markers require generated source; manual patterns remain executable globs.
  if (generated && (pattern.startsWith("=command:") || pattern.startsWith("=node-command:"))) {
    return "command text";
  }
  // Legacy hashes never match, including on manual entries that Doctor must retain.
  const legacyHashed = entry.argPattern?.startsWith(LEGACY_HASHED_ARG_PATTERN_PREFIX) === true;
  if (legacyHashed || (generated && !isCwdBoundHashedArgPattern(entry.argPattern))) {
    return "inactive";
  }
  if (isCwdBoundHashedArgPattern(entry.argPattern)) {
    return "argv+cwd";
  }
  return entry.argPattern ? "argv" : "any args";
}

function renderGeneratedArgPatternSubject(argv: string[]): string {
  const argsSlice = argv.slice(1);
  return argsSlice.length === 0 ? "\x00\x00" : argsSlice.join("\x00") + "\x00";
}

function renderGeneratedHashedArgPatternSubject(argv: string[]): string {
  const argsSlice = argv.slice(1);
  return `${argsSlice.length}\x00${argsSlice
    .map((arg) => `${Buffer.byteLength(arg, "utf8")}\x00${arg}\x00`)
    .join("")}`;
}

function normalizeGrantCwd(cwd: string, platform?: string | null): string {
  const effectivePlatform = normalizeLowercaseStringOrEmpty(platform ?? process.platform);
  const pathApi = effectivePlatform.startsWith("win") ? path.win32 : path.posix;
  return pathApi.normalize(cwd).replaceAll("\\", "/");
}

export function buildCwdBoundHashedArgPattern(
  argv: string[],
  cwd: string,
  platform?: string | null,
): string {
  const normalizedCwd = normalizeGrantCwd(cwd, platform);
  const subject = `${Buffer.byteLength(normalizedCwd, "utf8")}\x00${normalizedCwd}\x00${renderGeneratedHashedArgPatternSubject(argv)}`;
  const digest = crypto.createHash("sha256").update(subject, "utf8").digest("hex");
  return `${CWD_BOUND_HASHED_ARG_PATTERN_PREFIX}${digest}`;
}

function matchArgPattern(
  argPattern: string,
  regex: RegExp | null,
  argv: string[],
  platform?: string | null,
): boolean {
  if (!regex) {
    return false;
  }
  // Patterns built by buildArgPatternFromArgv use \x00 as the argument separator and
  // always include a trailing \x00 sentinel so that every auto-generated pattern
  // (including zero-arg "^\x00\x00$" and single-arg "^hello world\x00$") contains at
  // least one \x00.  This lets matchArgPattern detect the join style unambiguously
  // via .includes("\x00") without misidentifying anchored hand-authored patterns.
  // Legacy hand-authored patterns use a plain space and contain no \x00.
  // When \x00 style is active, a trailing \x00 is appended to the joined args string
  // to match the sentinel embedded in the pattern.
  // Every argv token remains authorization-significant: this boundary cannot prove
  // whether a redirect-shaped token was shell syntax or literal process data.
  //
  // Zero args use a double sentinel "\x00\x00" to distinguish [] from [""] — both
  // join to "" but must match different patterns ("^\x00\x00$" vs "^\x00$").
  const sep = argPattern.includes("\x00") ? "\x00" : " ";
  const argsString =
    sep === "\x00" ? renderGeneratedArgPatternSubject(argv) : argv.slice(1).join(sep);
  try {
    if (regex.test(argsString)) {
      return true;
    }
    // On Windows, LLMs may use either slash style. Also normalize when a Linux
    // gateway evaluates a Windows node command, using its target platform.
    const effectivePlatform = normalizeLowercaseStringOrEmpty(platform ?? process.platform);
    if (effectivePlatform.startsWith("win")) {
      const normalized = argsString.replace(/\//g, "\\");
      if (normalized !== argsString && regex.test(normalized)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function hasPathSelector(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.includes("~");
}

// Policy revisions own their entries. Weak keys retire matchers with those snapshots;
// compare patterns too because SDK callers can still edit their private copies.
const compiledAllowlistEntries = new WeakMap<
  ExecAllowlistEntry,
  {
    pattern: string;
    argPattern: string | undefined;
    platform: NodeJS.Platform;
    matches: (target: string) => boolean;
    argRegex: RegExp | null;
  }
>();

function prepareAllowlistEntry(entry: ExecAllowlistEntry, pattern: string) {
  let prepared = compiledAllowlistEntries.get(entry);
  if (
    prepared?.pattern !== pattern ||
    prepared.argPattern !== entry.argPattern ||
    prepared.platform !== process.platform
  ) {
    let argRegex: RegExp | null = null;
    if (entry.argPattern && !isGeneratedHashedArgPattern(entry.argPattern)) {
      try {
        argRegex = new RegExp(entry.argPattern);
      } catch {
        // Invalid argument patterns remain non-matching for this revision.
      }
    }
    prepared = {
      pattern,
      argPattern: entry.argPattern,
      platform: process.platform,
      matches: compileExecAllowlistPattern(pattern),
      argRegex,
    };
    compiledAllowlistEntries.set(entry, prepared);
  }
  return prepared;
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: ExecutableResolution | null,
  argv?: string[],
  platform?: string | null,
  cwd?: string,
): ExecAllowlistEntry | null {
  if (!entries.length) {
    return null;
  }
  // A bare "*" wildcard allows any parsed executable command.
  // Check it before the resolvedPath guard so unresolved PATH lookups still
  // match (for example platform-specific executables without known extensions).
  for (const entry of entries) {
    if (entry.pattern?.trim() === "*" && !entry.argPattern && entry.source !== "allow-always") {
      if (resolution) {
        return entry;
      }
      break;
    }
  }
  if (!resolution?.resolvedPath) {
    return null;
  }
  const trustPath = resolution.resolvedRealPath?.trim() || resolution.resolvedPath;
  // Basename grants apply only to PATH lookups, never ./tool or /tmp/tool.
  const allowBasename = !hasPathSelector(resolution.rawExecutable);
  let resolvedBasename: string | undefined;
  let pathOnlyMatch: ExecAllowlistEntry | null = null;
  let cwdBoundHash: string | undefined;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const pathSelector = hasPathSelector(pattern);
    if (!pathSelector && (pattern === "*" || !allowBasename)) {
      continue;
    }
    const { matches, argRegex } = prepareAllowlistEntry(entry, pattern);
    const patternMatches = pathSelector
      ? matches(trustPath)
      : (resolution.executableName && matches(resolution.executableName)) ||
        matches((resolvedBasename ??= path.basename(resolution.resolvedPath)));
    if (!patternMatches) {
      continue;
    }
    if (!entry.argPattern) {
      // Old generated allow-always entries were path-only and could authorize
      // changed argv after upgrade. Manual path-only entries have no source.
      if (entry.source === "allow-always") {
        continue;
      }
      if (!pathOnlyMatch) {
        pathOnlyMatch = entry;
      }
      continue;
    }
    if (!argv) {
      continue;
    }
    if (isCwdBoundHashedArgPattern(entry.argPattern)) {
      if (cwd === undefined) {
        continue;
      }
      cwdBoundHash ??= buildCwdBoundHashedArgPattern(argv, cwd, platform);
      if (entry.argPattern === cwdBoundHash) {
        return entry;
      }
    } else if (
      entry.source !== "allow-always" &&
      matchArgPattern(entry.argPattern, argRegex, argv, platform)
    ) {
      return entry;
    }
  }
  return pathOnlyMatch;
}

/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
export function parseExecArgvToken(raw: string) {
  if (!raw) {
    return { kind: "empty" as const, raw };
  }
  if (raw === "--") {
    return { kind: "terminator" as const, raw };
  }
  if (raw === "-") {
    return { kind: "stdin" as const, raw };
  }
  if (!raw.startsWith("-")) {
    return { kind: "positional" as const, raw };
  }
  if (raw.startsWith("--")) {
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 0) {
      return {
        kind: "option" as const,
        raw,
        style: "long" as const,
        flag: raw.slice(0, eqIndex),
        inlineValue: raw.slice(eqIndex + 1),
      };
    }
    return { kind: "option" as const, raw, style: "long" as const, flag: raw };
  }
  const cluster = raw.slice(1);
  return {
    kind: "option" as const,
    raw,
    style: "short-cluster" as const,
    cluster,
    flags: cluster.split("").map((entry) => `-${entry}`),
  };
}
