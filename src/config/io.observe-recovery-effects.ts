import type fs from "node:fs";
import { hasErrnoCode } from "../infra/errno.js";
import type { captureConfigHealthStateStore } from "./io.health-state.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";

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
