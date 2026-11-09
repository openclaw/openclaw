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
  requireIdentity = false,
): ConfigRecoveryEffect<fs.Stats | null> {
  const unavailable = (error: unknown): null => {
    if (requireIdentity && !hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  };
  return {
    sync: () => {
      try {
        return deps.fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
      } catch (error) {
        return unavailable(error);
      }
    },
    async: () => deps.fs.promises.stat(configPath).catch(unavailable),
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
  const unavailable = (error: unknown): null => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  };
  return {
    sync: () => {
      try {
        return deps.fs.readFileSync(backupPath, "utf-8");
      } catch (error) {
        return unavailable(error);
      }
    },
    async: () => deps.fs.promises.readFile(backupPath, "utf-8").catch(unavailable),
  };
}

export async function commitRecoveryFileIfCurrent(params: {
  health: ReturnType<typeof captureConfigHealthStateStore>;
  beforeCommit?: () => void;
  write: (assertCurrent: () => void) => Promise<unknown>;
}): Promise<boolean> {
  let superseded: Error | undefined;
  const assertObservationCurrent = () => {
    if (!params.health.isCurrent()) {
      superseded = new Error("Config recovery observation was superseded");
      throw superseded;
    }
  };
  try {
    await params.write(() => {
      assertObservationCurrent();
      params.beforeCommit?.();
      assertObservationCurrent();
    });
    return true;
  } catch (error) {
    if (superseded && error === superseded) {
      return false;
    }
    throw error;
  }
}
