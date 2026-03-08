import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitHeadPath } from "./git-root.js";

const formatCommit = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/[0-9a-fA-F]{7,40}/);
  if (!match) {
    return null;
  }
  return match[0].slice(0, 7).toLowerCase();
};

const cachedGitCommitBySearchDir = new Map<string, string | null>();

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const resolveCommitSearchDir = (options: { cwd?: string; moduleUrl?: string }) => {
  if (options.cwd) {
    return path.resolve(options.cwd);
  }
  if (options.moduleUrl) {
    try {
      return path.dirname(fileURLToPath(options.moduleUrl));
    } catch {
      // moduleUrl is not a valid file:// URL; fall back to process.cwd().
    }
  }
  return process.cwd();
};

/** Read at most `limit` bytes from a file to avoid unbounded reads. */
const safeReadFilePrefix = (filePath: string, limit = 256) => {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
};

const cacheGitCommit = (searchDir: string, commit: string | null) => {
  cachedGitCommitBySearchDir.set(searchDir, commit);
  return commit;
};

const resolveGitRefsBase = (headPath: string) => {
  const gitDir = path.dirname(headPath);
  try {
    const commonDir = safeReadFilePrefix(path.join(gitDir, "commondir")).trim();
    if (commonDir) {
      return path.resolve(gitDir, commonDir);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    // Plain repo git dirs do not have commondir.
  }
  return gitDir;
};

/** Safely resolve a git ref path, rejecting traversal attacks from a crafted HEAD file. */
const resolveRefPath = (headPath: string, ref: string) => {
  if (!ref.startsWith("refs/")) {
    return null;
  }
  if (path.isAbsolute(ref)) {
    return null;
  }
  if (ref.split(/[/]/).includes("..")) {
    return null;
  }
  const refsBase = resolveGitRefsBase(headPath);
  const resolved = path.resolve(refsBase, ref);
  const rel = path.relative(refsBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
};

const readCommitFromPackageJson = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as {
      gitHead?: string;
      githead?: string;
    };
    return formatCommit(pkg.gitHead ?? pkg.githead ?? null);
  } catch {
    return null;
  }
};

const readCommitFromBuildInfo = () => {
  try {
    const require = createRequire(import.meta.url);
    const candidates = ["../build-info.json", "./build-info.json"];
    for (const candidate of candidates) {
      try {
        const info = require(candidate) as {
          commit?: string | null;
        };
        const formatted = formatCommit(info.commit ?? null);
        if (formatted) {
          return formatted;
        }
      } catch {
        // ignore missing candidate
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const resolveCommitHash = (
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
  } = {},
) => {
  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    return normalized;
  }
  const buildInfoCommit = readCommitFromBuildInfo();
  if (buildInfoCommit) {
    return buildInfoCommit;
  }
  const pkgCommit = readCommitFromPackageJson();
  if (pkgCommit) {
    return pkgCommit;
  }

  const searchDir = resolveCommitSearchDir(options);
  if (cachedGitCommitBySearchDir.has(searchDir)) {
    return cachedGitCommitBySearchDir.get(searchDir) ?? null;
  }
  try {
    const headPath = resolveGitHeadPath(searchDir);
    if (!headPath) {
      return cacheGitCommit(searchDir, null);
    }
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      return cacheGitCommit(searchDir, null);
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refPath = resolveRefPath(headPath, ref);
      if (!refPath) {
        return cacheGitCommit(searchDir, null);
      }
      const refHash = safeReadFilePrefix(refPath).trim();
      return cacheGitCommit(searchDir, formatCommit(refHash));
    }
    return cacheGitCommit(searchDir, formatCommit(head));
  } catch {
    return null;
  }
};
