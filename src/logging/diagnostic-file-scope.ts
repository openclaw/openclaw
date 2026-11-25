import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as openFsRoot } from "@openclaw/fs-safe/root";
import { resolveConfigPath, resolveIncludeRoots, resolveStateDir } from "../config/paths.js";
import { realpathViaExistingPrefix } from "../infra/path-containment.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSameRollingLogFileFamily } from "./log-file-path.js";

export const DIAGNOSTIC_FILE_SCOPE_ERROR =
  "The file is outside the diagnostics read scope. Only files under the OpenClaw install root or the Gateway log file can be read, excluding private and hidden files.";

export type ProtectedDiagnosticPaths = {
  configPath: string;
  stateDir: string;
  includeRoots: string[];
};

export function resolveProtectedDiagnosticPaths(): ProtectedDiagnosticPaths {
  return {
    configPath: resolveConfigPath(),
    stateDir: resolveStateDir(),
    includeRoots: resolveIncludeRoots(),
  };
}

export async function assertDiagnosticPathAllowed(
  declared: string,
  real: string,
  { configPath, stateDir, includeRoots }: ProtectedDiagnosticPaths,
): Promise<void> {
  // Include candidates are confined to these roots. Protect the roots themselves so a
  // valid or invalid disk edit cannot expose sources the Gateway previously loaded.
  const privateRoots = [path.dirname(configPath), stateDir, ...includeRoots];
  const [realConfig, ...realRoots] = await Promise.all(
    [configPath, ...privateRoots].map(realpathViaExistingPrefix),
  );
  if (
    path.relative(configPath, declared) === "" ||
    privateRoots.some((root) => isPathInside(root, declared)) ||
    !realConfig ||
    path.relative(realConfig, real) === "" ||
    realRoots.some((root) => !root || isPathInside(root, real))
  ) {
    throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
  }
}

export function matchesDiagnosticLogName(
  candidate: string,
  target: { file: string; rolling: boolean },
): boolean {
  return (
    candidate === path.basename(target.file) ||
    (target.rolling && isSameRollingLogFileFamily(target.file, candidate))
  );
}

export function createDiagnosticLogOpener(protectedPaths: ProtectedDiagnosticPaths) {
  return async (file: string, target: { file: string; rolling: boolean }) => {
    const logDir = path.dirname(target.file);
    const name = path.basename(file);
    if (
      name.startsWith(".") ||
      path.relative(logDir, file) !== name ||
      !matchesDiagnosticLogName(name, target)
    ) {
      throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
    }
    const scope = await openFsRoot(logDir);
    const { handle, realPath } = await scope
      .open(name, { hardlinks: "reject", symlinks: "reject" })
      .catch((error: unknown) => {
        if (error instanceof FsSafeError && error.category === "policy") {
          throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
        }
        throw error;
      });
    try {
      if (path.relative(scope.rootReal, realPath) !== name) {
        throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
      }
      await assertDiagnosticPathAllowed(file, realPath, protectedPaths);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
}
