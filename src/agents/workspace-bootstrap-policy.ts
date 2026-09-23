import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { Minimatch } from "minimatch";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHookConfig } from "../hooks/policy.js";
import { isPathInside } from "../infra/path-guards.js";
import { CANONICAL_ROOT_MEMORY_FILENAME } from "../memory/root-memory-files.js";

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = CANONICAL_ROOT_MEMORY_FILENAME;
export const GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
] as const;

/**
 * Canonical bootstrap filenames in prompt order. Single source for the runtime
 * validation set, the name union, and the Control UI core-files list; a private
 * copy anywhere else silently drifts when a file is retired.
 */
export const WORKSPACE_BOOTSTRAP_FILENAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
] as const;

export type WorkspaceBootstrapFileName = (typeof WORKSPACE_BOOTSTRAP_FILENAMES)[number];

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
  /** Set only by the authenticated personal USER loader, never inferred from a path. */
  personalUser?: true;
};

export function hasGlobPattern(pattern: string): boolean {
  // Keep square brackets literal here; workspace paths commonly contain them.
  return /[?*{}]/u.test(pattern);
}

export function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

export function resolveGlobWalkRoot(pattern: string): string {
  const normalized = normalizeWorkspacePatternPath(pattern);
  const globIndex = normalized.search(/[?*{}]/u);
  if (globIndex === -1) {
    return normalized;
  }
  const slashIndex = normalized.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "." : normalized.slice(0, slashIndex) || ".";
}

export function createBootstrapPatternMatcher(pattern: string): Minimatch {
  return new Minimatch(normalizeWorkspacePatternPath(pattern), {
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
  });
}

/** Resolve the hook's existing paths, patterns, and files keys in precedence order. */
export function resolveExtraBootstrapPatterns(cfg: OpenClawConfig | undefined): string[] {
  const hookConfig = resolveHookConfig(cfg, "bootstrap-extra-files");
  if (!hookConfig || hookConfig.enabled === false) {
    return [];
  }
  for (const value of [hookConfig.paths, hookConfig.patterns, hookConfig.files]) {
    const patterns = normalizeTrimmedStringList(value);
    if (patterns.length > 0) {
      return patterns;
    }
  }
  return [];
}

/** Restrict a workspace adapter to native bootstrap reads and owner-document writes. */
export function createWorkspaceBootstrapFilePolicy(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): {
  canRead: (relativePath: string) => boolean;
  canList: (relativePath: string) => boolean;
  canWrite: (relativePath: string) => boolean;
} {
  const workspaceDir = path.resolve(params.workspaceDir);
  const names: ReadonlySet<string> = new Set(WORKSPACE_BOOTSTRAP_FILENAMES);
  const ownerNames: ReadonlySet<string> = new Set(GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES);
  const patterns =
    params.config?.hooks?.internal?.enabled === false
      ? []
      : resolveExtraBootstrapPatterns(params.config);
  const literals = new Set<string>();
  const globs: Array<{ walkRoot: string; matcher: Minimatch }> = [];
  for (const pattern of patterns) {
    const walkRoot = path.resolve(workspaceDir, resolveGlobWalkRoot(pattern));
    if (pattern.includes("\0") || !isPathInside(workspaceDir, walkRoot)) {
      continue;
    }
    if (hasGlobPattern(pattern)) {
      globs.push({ walkRoot, matcher: createBootstrapPatternMatcher(pattern) });
    } else {
      literals.add(
        path.relative(workspaceDir, path.resolve(workspaceDir, pattern)).split(path.sep).join("/"),
      );
    }
  }
  const isRelativePath = (value: string) =>
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  return {
    canRead(relativePath) {
      if (!isRelativePath(relativePath) || !names.has(path.basename(relativePath))) {
        return false;
      }
      return (
        names.has(relativePath) ||
        literals.has(relativePath) ||
        globs.some(({ matcher }) => matcher.match(normalizeWorkspacePatternPath(relativePath)))
      );
    },
    canList(relativePath) {
      if (relativePath !== "." && !isRelativePath(relativePath)) {
        return false;
      }
      const directory = path.resolve(workspaceDir, relativePath);
      return globs.some(
        ({ walkRoot, matcher }) =>
          isPathInside(walkRoot, directory) &&
          (directory === walkRoot ||
            matcher.match(normalizeWorkspacePatternPath(relativePath), true)),
      );
    },
    canWrite: (relativePath) => ownerNames.has(relativePath),
  };
}
