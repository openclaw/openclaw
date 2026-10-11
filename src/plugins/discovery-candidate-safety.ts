import fs from "node:fs";
import path from "node:path";
import type { PluginDiagnostic } from "./manifest-types.js";
import { formatPosixMode, isPathInside } from "./path-safety.js";
import {
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  refreshPluginCacheStat,
} from "./plugin-cache-files.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type CandidateBlockIssue = Pick<PluginDiagnostic, "source" | "message" | "code">;

export function checkPluginSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = pluginCacheRealpathSync(params.source);
  const rootRealPath = pluginCacheRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath || isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    code: "plugin-candidate-blocked",
    source: params.source,
    message: `blocked plugin candidate: source escapes plugin root (${params.source} -> ${sourceRealPath}; root=${rootRealPath})`,
  };
}

export function checkPluginPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const seen = new Set<string>();
  for (const targetPath of [params.rootDir, params.source]) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    let stat = pluginCacheStatSync(targetPath);
    if (!stat) {
      return blockedPath(targetPath, `cannot stat path (${targetPath})`);
    }
    let modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0 && params.origin === "bundled") {
      try {
        fs.chmodSync(targetPath, modeBits & ~0o022);
        const repairedStat = refreshPluginCacheStat(targetPath);
        if (!repairedStat) {
          return blockedPath(targetPath, `cannot stat path (${targetPath})`);
        }
        stat = repairedStat;
        modeBits = repairedStat.mode & 0o777;
      } catch {
        // The normal safety gate below reports an unrepaired directory.
      }
    }
    if ((modeBits & 0o002) !== 0) {
      return blockedPath(
        targetPath,
        `world-writable path (${targetPath}, mode=${formatPosixMode(modeBits)})`,
      );
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return blockedPath(
        targetPath,
        `suspicious ownership (${targetPath}, uid=${stat.uid}, expected uid=${params.uid} or root)`,
      );
    }
  }
  return null;
}

function blockedPath(source: string, reason: string): CandidateBlockIssue {
  return {
    code: "plugin-candidate-blocked",
    source,
    message: `blocked plugin candidate: ${reason}`,
  };
}
