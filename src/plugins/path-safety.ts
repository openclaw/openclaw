/** Plugin-local re-export of shared path safety helpers for plugin install/runtime code. */
import fs from "node:fs";
import path from "node:path";
import { isPathInside as isPathInsideLexical } from "@openclaw/fs-safe/path";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { FsSafeError } from "../infra/fs-safe.js";

export { formatPosixMode } from "@openclaw/fs-safe/advanced";
export { safeRealpathSync, safeStatSync } from "@openclaw/fs-safe/path";

export type PhysicalPathInsideRoot = {
  rootPath: string;
  targetPath: string;
  rootIdentity: Readonly<{ dev: bigint; ino: bigint }>;
};

/** Resolves matching physical spellings when Windows presents one tree through different aliases. */
function resolvePhysicalPathInsideRootSync(
  rootPath: string,
  targetPath: string,
): PhysicalPathInsideRoot | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const root = fs.statSync(rootPath, { bigint: true });
    if (!root.isDirectory() || root.ino === 0n) {
      return undefined;
    }
    // Walk the observed target spelling to prove identity, then rebuild the
    // target beneath the root spelling that the descriptor boundary admits.
    let current = path.resolve(targetPath);
    while (true) {
      const candidate = fs.statSync(current, { bigint: true });
      if (candidate.dev === root.dev && candidate.ino === root.ino) {
        // Prefer the matching observed spelling unless it is itself a link.
        // Windows 8.3 aliases are ordinary directory paths; junction roots retain
        // their already-admitted canonical spelling.
        const physicalRoot = fs.lstatSync(current).isSymbolicLink()
          ? path.resolve(rootPath)
          : current;
        return {
          rootPath: physicalRoot,
          targetPath: path.resolve(physicalRoot, path.relative(current, targetPath)),
          rootIdentity: Object.freeze({ dev: root.dev, ino: root.ino }),
        };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  } catch {
    return undefined;
  }
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  return (
    isPathInsideLexical(rootPath, targetPath) ||
    resolvePhysicalPathInsideRootSync(rootPath, targetPath) !== undefined
  );
}

/** Returns a target's relative path after proving a Windows alias names the same root. */
export function relativePluginPathInsideRootSync(
  rootPath: string,
  targetPath: string,
): string | undefined {
  if (isPathInsideLexical(rootPath, targetPath)) {
    return path.relative(path.resolve(rootPath), path.resolve(targetPath));
  }
  const physical = resolvePhysicalPathInsideRootSync(rootPath, targetPath);
  return physical ? path.relative(physical.rootPath, physical.targetPath) : undefined;
}

function createIdentityBoundRootFileFs(
  rootPath: string,
  expected: PhysicalPathInsideRoot["rootIdentity"],
) {
  const lstatSync = ((...args: unknown[]) => {
    // SAFETY: Reflect invokes fs.lstatSync with the original overload arguments.
    const stat = Reflect.apply(fs.lstatSync, fs, args) as fs.Stats | fs.BigIntStats;
    if (args[0] === rootPath) {
      const dev = typeof stat.dev === "bigint" ? stat.dev : BigInt(stat.dev);
      const ino = typeof stat.ino === "bigint" ? stat.ino : BigInt(stat.ino);
      if (!stat.isDirectory() || dev !== expected.dev || ino !== expected.ino) {
        throw new FsSafeError(
          "path-mismatch",
          "plugin root identity changed during alias reconciliation",
        );
      }
    }
    return stat;
    // SAFETY: The wrapper returns lstatSync results unchanged after identity validation.
  }) as typeof fs.lstatSync;
  return {
    closeSync: fs.closeSync,
    constants: fs.constants,
    fstatSync: fs.fstatSync,
    lstatSync,
    openSync: fs.openSync,
    readFileSync: fs.readFileSync,
    realpathSync: fs.realpathSync,
  };
}

/** Opens a plugin artifact after reconciling Windows root aliases. */
export function openPluginRootFileSync(params: {
  rootPath: string;
  rootRealPath?: string;
  filePath: string;
  rejectHardlinks: boolean;
  boundaryLabel?: string;
  maxBytes?: number;
}) {
  const admittedRoot = params.rootRealPath ?? params.rootPath;
  const physical = isPathInsideLexical(admittedRoot, params.filePath)
    ? undefined
    : resolvePhysicalPathInsideRootSync(admittedRoot, params.filePath);
  return openRootFileSync({
    absolutePath: physical?.targetPath ?? params.filePath,
    rootPath: physical?.rootPath ?? params.rootPath,
    rootRealPath: physical?.rootPath ?? params.rootRealPath,
    boundaryLabel: params.boundaryLabel ?? "plugin root",
    rejectHardlinks: params.rejectHardlinks,
    maxBytes: params.maxBytes,
    skipLexicalRootCheck: physical ? true : undefined,
    ioFs: physical
      ? createIdentityBoundRootFileFs(physical.rootPath, physical.rootIdentity)
      : undefined,
  });
}
