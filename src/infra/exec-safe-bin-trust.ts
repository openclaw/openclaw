// Resolves trusted directories for safe-bin allowlist policy.
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sameFsObject, swapAsciiCase } from "./path-case.js";

// Keep defaults to OS-managed immutable bins only.
// User/package-manager bins must be opted in via tools.exec.safeBinTrustedDirs.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];

type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
};

export type WritableTrustedSafeBinDir = {
  dir: string;
  worldWritable: boolean;
};

async function pathCaseInsensitive(value: string): Promise<boolean> {
  let candidate = value;
  for (;;) {
    const swapped = swapAsciiCase(candidate);
    if (swapped !== candidate) {
      try {
        const original = await fs.stat(candidate);
        try {
          const alternate = await fs.stat(swapped);
          return sameFsObject(original, alternate);
        } catch {
          return false;
        }
      } catch {
        // The compared path may not exist yet; probe the closest existing parent.
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return process.platform === "win32";
    }
    candidate = parent;
  }
}

async function normalizeTrustComparisonPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return (await pathCaseInsensitive(resolved)) ? resolved.toLowerCase() : resolved;
}

export function normalizeTrustedSafeBinDirs(entries?: readonly string[] | null): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return uniqueStrings(normalized);
}

async function resolveTrustedSafeBinDirs(entries: readonly string[]): Promise<string[]> {
  return sortUniqueStrings(await Promise.all(entries.map(normalizeTrustComparisonPath)));
}

function hasPathSelector(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function isExecutableSafeBinFile(value: string): Promise<boolean> {
  try {
    const stats = await fs.stat(value);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await fs.access(value, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveTrustedSafeBinTargetDirs(
  entries: readonly string[],
  safeBins: readonly string[],
): Promise<string[]> {
  const dirs: string[] = [];
  const bins = Array.from(
    new Set(
      safeBins.map((entry) => entry.trim()).filter((entry) => entry && !hasPathSelector(entry)),
    ),
  ).toSorted();
  if (bins.length === 0) {
    return dirs;
  }
  for (const entry of entries) {
    const dir = path.resolve(entry);
    for (const bin of bins) {
      const candidate = path.join(dir, bin);
      if (!(await isExecutableSafeBinFile(candidate))) {
        continue;
      }
      try {
        dirs.push(path.dirname(await fs.realpath(candidate)));
      } catch {
        // Missing binaries are resolved normally at command time.
      }
    }
  }
  return sortUniqueStrings(dirs);
}

export async function getTrustedSafeBinDirs(
  params: {
    extraDirs?: readonly string[];
    safeBins?: readonly string[];
  } = {},
): Promise<Set<string>> {
  const extraDirs = params.extraDirs ?? [];
  const safeBins = params.safeBins ?? [];
  const entries = normalizeTrustedSafeBinDirs([...DEFAULT_SAFE_BIN_TRUSTED_DIRS, ...extraDirs]);
  const targetDirs = await resolveTrustedSafeBinTargetDirs(entries, safeBins);
  return new Set(await resolveTrustedSafeBinDirs(sortUniqueStrings([...entries, ...targetDirs])));
}

export async function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): Promise<boolean> {
  const trustedDirs = params.trustedDirs ?? (await getTrustedSafeBinDirs());
  const resolvedDir = await normalizeTrustComparisonPath(
    path.dirname(path.resolve(params.resolvedPath)),
  );
  return trustedDirs.has(resolvedDir);
}

export async function listWritableExplicitTrustedSafeBinDirs(
  entries?: readonly string[] | null,
): Promise<WritableTrustedSafeBinDir[]> {
  if (process.platform === "win32") {
    return [];
  }
  const resolved = sortUniqueStrings(
    normalizeTrustedSafeBinDirs(entries).map((dir) => path.resolve(dir)),
  );
  const hits: WritableTrustedSafeBinDir[] = [];
  for (const dir of resolved) {
    let stat: Stats;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const mode = stat.mode & 0o777;
    const groupWritable = (mode & 0o020) !== 0;
    const worldWritable = (mode & 0o002) !== 0;
    if (!groupWritable && !worldWritable) {
      continue;
    }
    hits.push({ dir, worldWritable });
  }
  return hits;
}
