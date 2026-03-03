import path from "node:path";
import { matchesExecAllowlistPattern } from "../infra/exec-allowlist-pattern.js";
import { resolvePathFromInput } from "./path-policy.js";

export type ToolWritePathPolicy = {
  allow?: string[];
  deny?: string[];
};

function normalizePatternList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of value) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return Array.from(unique);
}

export function normalizeToolWritePathPolicy(
  policy: ToolWritePathPolicy | undefined,
): ToolWritePathPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  const allow = normalizePatternList(policy.allow);
  const deny = normalizePatternList(policy.deny);
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  return {
    allow: allow.length > 0 ? allow : undefined,
    deny: deny.length > 0 ? deny : undefined,
  };
}

function resolvePattern(pattern: string, workspaceRoot: string): string {
  if (pattern.startsWith("~")) {
    return pattern;
  }
  if (path.isAbsolute(pattern)) {
    return pattern;
  }
  return path.resolve(workspaceRoot, pattern);
}

function matchPattern(patterns: string[] | undefined, targetPath: string, workspaceRoot: string) {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }
  for (const pattern of patterns) {
    const resolvedPattern = resolvePattern(pattern, workspaceRoot);
    if (matchesExecAllowlistPattern(resolvedPattern, targetPath)) {
      return pattern;
    }
  }
  return undefined;
}

function formatPathForError(targetPath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, targetPath);
  if (!relative || relative === ".") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return targetPath;
  }
  return relative;
}

export function assertToolWritePathAllowed(params: {
  policy?: ToolWritePathPolicy;
  workspaceRoot: string;
  candidatePath: string;
  cwd?: string;
}): void {
  const normalized = normalizeToolWritePathPolicy(params.policy);
  if (!normalized) {
    return;
  }
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const targetPath = resolvePathFromInput(params.candidatePath, params.cwd ?? workspaceRoot);
  const displayPath = formatPathForError(targetPath, workspaceRoot);

  const denyMatch = matchPattern(normalized.deny, targetPath, workspaceRoot);
  if (denyMatch) {
    throw new Error(
      `write denied: path "${displayPath}" matches cron payload.paths.deny pattern "${denyMatch}"`,
    );
  }

  const allow = normalized.allow;
  if (allow && allow.length > 0) {
    const allowMatch = matchPattern(allow, targetPath, workspaceRoot);
    if (!allowMatch) {
      throw new Error(
        `write denied: path "${displayPath}" is not allowed by cron payload.paths.allow`,
      );
    }
  }
}
