import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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

let cachedCommit: string | null | undefined;

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
  const gitDir = path.dirname(headPath);
  const resolved = path.resolve(gitDir, ref);
  const rel = path.relative(gitDir, resolved);
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

export const resolveCommitHash = (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  if (cachedCommit !== undefined) {
    return cachedCommit;
  }
  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    cachedCommit = normalized;
    return cachedCommit;
  }
  const buildInfoCommit = readCommitFromBuildInfo();
  if (buildInfoCommit) {
    cachedCommit = buildInfoCommit;
    return cachedCommit;
  }
  const pkgCommit = readCommitFromPackageJson();
  if (pkgCommit) {
    cachedCommit = pkgCommit;
    return cachedCommit;
  }
  try {
    const headPath = resolveGitHeadPath(options.cwd ?? process.cwd());
    if (!headPath) {
      cachedCommit = null;
      return cachedCommit;
    }
    const head = safeReadFilePrefix(headPath).trim();
    if (!head) {
      cachedCommit = null;
      return cachedCommit;
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refPath = resolveRefPath(headPath, ref);
      if (!refPath) {
        cachedCommit = null;
        return cachedCommit;
      }
      const refHash = safeReadFilePrefix(refPath).trim();
      cachedCommit = formatCommit(refHash);
      return cachedCommit;
    }
    cachedCommit = formatCommit(head);
    return cachedCommit;
  } catch {
    cachedCommit = null;
    return cachedCommit;
  }
};
