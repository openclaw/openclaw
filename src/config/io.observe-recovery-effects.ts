import type fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../infra/replace-file.js";
import type { captureConfigHealthStateStore } from "./io.health-state.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";

export type ConfigRecoveryEffect<T> = {
  sync: () => T;
  async: (health: ReturnType<typeof captureConfigHealthStateStore>) => T | Promise<T>;
};

export function createConfigRecoveryStatEffect(
  deps: Pick<NormalizedConfigIoDeps, "fs">,
  configPath: string,
): ConfigRecoveryEffect<fs.Stats | null> {
  return {
    sync: () => {
      try {
        return deps.fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
      } catch {
        return null;
      }
    },
    async: () => deps.fs.promises.stat(configPath).catch(() => null),
  };
}

export function createConfigBackupMissingEffect(
  deps: Pick<NormalizedConfigIoDeps, "fs">,
  backupPath: string,
): ConfigRecoveryEffect<boolean> {
  return {
    sync: () => {
      try {
        deps.fs.statSync(backupPath);
        return false;
      } catch (error) {
        return hasErrnoCode(error, "ENOENT");
      }
    },
    async: () =>
      deps.fs.promises.stat(backupPath).then(
        () => false,
        (error: unknown) => hasErrnoCode(error, "ENOENT"),
      ),
  };
}

export function createConfigBackupReadEffect(
  deps: Pick<NormalizedConfigIoDeps, "fs">,
  backupPath: string,
): ConfigRecoveryEffect<string | null> {
  return {
    sync: () => {
      try {
        return deps.fs.readFileSync(backupPath, "utf-8");
      } catch {
        return null;
      }
    },
    async: () => deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null),
  };
}

export async function commitRecoveryFileIfCurrent(params: {
  health: ReturnType<typeof captureConfigHealthStateStore>;
  beforeCommit?: () => void;
  write: (assertCurrent: () => void) => Promise<unknown>;
}): Promise<boolean> {
  let superseded: Error | undefined;
  try {
    await params.write(() => {
      params.beforeCommit?.();
      if (!params.health.isCurrent()) {
        superseded = new Error("Config recovery observation was superseded");
        throw superseded;
      }
    });
    return true;
  } catch (error) {
    if (superseded && error === superseded) {
      return false;
    }
    throw error;
  }
}

export function createRecoveryCommitEffect(params: {
  deps: Pick<NormalizedConfigIoDeps, "fs">;
  configPath: string;
  raw: string;
  beforeCommit?: () => void;
}): ConfigRecoveryEffect<boolean> {
  const options = {
    filePath: params.configPath,
    content: params.raw,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(params.configPath),
    fileSystem: params.deps.fs,
  };
  return {
    sync: () => {
      replaceFileAtomicSync(options);
      return true;
    },
    async: (health) =>
      commitRecoveryFileIfCurrent({
        health,
        beforeCommit: params.beforeCommit,
        write: (assertCurrent) =>
          replaceFileAtomic({
            ...options,
            // Every rename attempt must revalidate; copy fallback has no final guard.
            copyFallbackOnPermissionError: false,
            fileSystem: {
              promises: {
                ...params.deps.fs.promises,
                rename: (source: fs.PathLike, destination: fs.PathLike) => {
                  assertCurrent();
                  return params.deps.fs.promises.rename(source, destination);
                },
              },
            },
          }),
      }),
  };
}
