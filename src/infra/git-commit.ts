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
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
};

let cachedBuildOrPackageCommit: string | null | undefined;

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

const resolveBuildOrPackageCommit = () => {
  if (cachedBuildOrPackageCommit !== undefined) {
    return cachedBuildOrPackageCommit;
  }
  cachedBuildOrPackageCommit = readCommitFromBuildInfo() ?? readCommitFromPackageJson();
  return cachedBuildOrPackageCommit;
};

export const resolveCommitHash = (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    return normalized;
  }
  const buildOrPackageCommit = resolveBuildOrPackageCommit();
  if (buildOrPackageCommit) {
    return buildOrPackageCommit;
  }
  try {
    const headPath = resolveGitHeadPath(options.cwd ?? process.cwd());
    if (!headPath) {
      return null;
    }
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      return null;
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refPath = path.resolve(path.dirname(headPath), ref);
      const refHash = fs.readFileSync(refPath, "utf-8").trim();
      return formatCommit(refHash);
    }
    return formatCommit(head);
  } catch {
    return null;
  }
};

export function resetCommitHashCacheForTests(): void {
  cachedBuildOrPackageCommit = undefined;
}
