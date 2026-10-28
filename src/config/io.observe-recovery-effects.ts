import type fs from "node:fs";
import { hasErrnoCode, ignoreMissingPath } from "../infra/errno.js";
import type { captureConfigAuditAppender } from "./io.audit.js";
import type { captureConfigHealthStateStore } from "./io.health-state.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";

export type ConfigRecoveryEffect<T> = {
  sync: () => T;
  async: (
    health: ReturnType<typeof captureConfigHealthStateStore>,
    appendAudit: ReturnType<typeof captureConfigAuditAppender>,
  ) => T | Promise<T>;
};

export async function commitConfigRecoveryFile(params: {
  health: ReturnType<typeof captureConfigHealthStateStore>;
  beforeCommit?: () => void;
  write: (assertCurrent: () => void) => Promise<unknown>;
}): Promise<void> {
  await params.write(() => {
    params.beforeCommit?.();
    params.health.assertCurrent();
  });
}

/** Recheck original external bytes at mutation, not process-local observation order. */
export function createConfigRecoverySourceGuard(
  deps: Pick<NormalizedConfigIoDeps, "fs">,
  sources: ReadonlyArray<readonly [pathname: string, raw: string, stat: fs.Stats | null]>,
  requireIdentity = false,
): () => void {
  return () => {
    for (const [pathname, expectedRaw, expectedStat] of sources) {
      const actualRaw = createConfigBackupReadEffect(deps, pathname).sync();
      const actualStat = createConfigRecoveryStatEffect(deps, pathname, requireIdentity).sync();
      if (
        actualRaw !== expectedRaw ||
        (requireIdentity && (!actualStat || !expectedStat)) ||
        (actualStat &&
          expectedStat &&
          (actualStat.dev !== expectedStat.dev ||
            actualStat.ino !== expectedStat.ino ||
            actualStat.mtimeMs !== expectedStat.mtimeMs ||
            actualStat.size !== expectedStat.size))
      ) {
        throw new ConfigMutationConflictError("config recovery source changed since preparation", {
          retryable: false,
        });
      }
    }
  };
}

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
    ignoreMissingPath(error);
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
