import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const formatCommit = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
};

const resolveGitHead = (startDir: string) => {
  let current = startDir;
  for (let i = 0; i < 12; i += 1) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return path.join(gitPath, "HEAD");
      }
      if (stat.isFile()) {
        const raw = fs.readFileSync(gitPath, "utf-8");
        const match = raw.match(/gitdir:\s*(.+)/i);
        if (match?.[1]) {
          const resolved = path.resolve(current, match[1].trim());
          return path.join(resolved, "HEAD");
        }
      }
    } catch {
      // ignore missing .git at this level
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
};

let cachedCommit: string | null | undefined;

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

/**
 * Resolve the commit hash of the upstream tracking branch (e.g., origin/main).
 * Returns null if not in a git repo or no upstream is configured.
 */
export const resolveUpstreamCommitHash = (options: { cwd?: string } = {}): string | null => {
  try {
    const gitDir = resolveGitDir(options.cwd ?? process.cwd());
    if (!gitDir) {
      return null;
    }
    // Read the current branch name
    const headPath = path.join(gitDir, "HEAD");
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head.startsWith("ref:")) {
      return null; // detached HEAD
    }
    const ref = head.replace(/^ref:\s*/i, "").trim();
    const branchName = ref.replace(/^refs\/heads\//, "");

    // Read the upstream tracking branch from config
    const configPath = path.join(gitDir, "config");
    const config = fs.readFileSync(configPath, "utf-8");

    // Parse the config to find [branch "branchName"] section
    const branchSection = new RegExp(`\\[branch\\s+"${branchName}"\\]([^\\[]+)`, "i");
    const match = config.match(branchSection);
    if (!match) {
      return null;
    }
    const section = match[1];
    const remoteMatch = section.match(/remote\s*=\s*(\S+)/i);
    const mergeMatch = section.match(/merge\s*=\s*(\S+)/i);
    if (!remoteMatch || !mergeMatch) {
      return null;
    }
    const remote = remoteMatch[1];
    const mergeBranch = mergeMatch[1].replace(/^refs\/heads\//, "");

    // Read the upstream ref
    const upstreamRef = `refs/remotes/${remote}/${mergeBranch}`;
    const packedRefsPath = path.join(gitDir, "packed-refs");
    const looseRefPath = path.join(gitDir, upstreamRef);

    // Try loose ref first
    try {
      const hash = fs.readFileSync(looseRefPath, "utf-8").trim();
      return formatCommit(hash);
    } catch {
      // Try packed-refs
      try {
        const packed = fs.readFileSync(packedRefsPath, "utf-8");
        const lines = packed.split("\n");
        for (const line of lines) {
          if (line.startsWith("#") || !line.trim()) {
            continue;
          }
          const [hash, refName] = line.split(/\s+/);
          if (refName === upstreamRef) {
            return formatCommit(hash);
          }
        }
      } catch {
        // No packed-refs
      }
    }
    return null;
  } catch {
    return null;
  }
};

const resolveGitDir = (startDir: string): string | null => {
  let current = startDir;
  for (let i = 0; i < 12; i += 1) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return gitPath;
      }
      if (stat.isFile()) {
        const raw = fs.readFileSync(gitPath, "utf-8");
        const match = raw.match(/gitdir:\s*(.+)/i);
        if (match?.[1]) {
          return path.resolve(current, match[1].trim());
        }
      }
    } catch {
      // ignore missing .git at this level
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
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
    const headPath = resolveGitHead(options.cwd ?? process.cwd());
    if (!headPath) {
      cachedCommit = null;
      return cachedCommit;
    }
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      cachedCommit = null;
      return cachedCommit;
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refPath = path.resolve(path.dirname(headPath), ref);
      const refHash = fs.readFileSync(refPath, "utf-8").trim();
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
