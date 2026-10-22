import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../plugins/install-root-context.js";
import {
  getPluginSourceCaptureStorage,
  withPluginSourceCaptureStorage,
} from "../plugins/plugin-source-capture-context.js";
import { artifactPreservingReads } from "../state/artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  forkActiveOpenClawStateDatabaseReadSnapshot,
  withDisposableOpenClawStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export type DoctorLintPluginStateRunner = <T>(
  run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
) => Promise<T>;

export class DoctorLintStateSnapshotError extends Error {
  constructor(cause: unknown) {
    super(
      `Doctor lint could not prepare a private plugin-state snapshot: ${scrubDoctorErrorMessage(cause)}`,
      { cause },
    );
    this.name = "DoctorLintStateSnapshotError";
  }
}

/** One mutable inspection image belongs to the report, separate from its immutable read view. */
export async function withReadOnlyPluginStateSnapshot<T>(
  sourceEnv: NodeJS.ProcessEnv,
  run: (inspect: DoctorLintPluginStateRunner) => Promise<T>,
  cleanupWarnings?: HealthFinding[],
): Promise<T> {
  let preparation: ReturnType<typeof prepareReadOnlyPluginStateSnapshot> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareReadOnlyPluginStateSnapshot>> | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      value: await run(async (inspect) => {
        prepared ??= await (preparation ??= prepareReadOnlyPluginStateSnapshot(
          sourceEnv,
          cleanupWarnings,
        ));
        return prepared.run(inspect);
      }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await prepared?.close();
  } catch (error) {
    // Report disposal must preserve any detector error already in flight.
    throw new DoctorLintStateSnapshotError(
      outcome.ok
        ? error
        : new AggregateError(
            [outcome.error, error],
            `${scrubDoctorErrorMessage(outcome.error)}; ${scrubDoctorErrorMessage(error)}`,
          ),
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

async function prepareReadOnlyPluginStateSnapshot(
  sourceEnv: NodeJS.ProcessEnv,
  cleanupWarnings?: HealthFinding[],
) {
  const sourceDatabasePath = resolveOpenClawStateSqlitePath(sourceEnv);
  const captureStorage = {
    stateDir: getPluginSourceCaptureStorage()?.stateDir ?? resolveStateDir(sourceEnv),
    placement: "temporary" as const,
  };
  const installRoots = resolvePluginInstallRoots(sourceEnv);
  let cleanup: () => Promise<boolean>;
  let privateRoot: string;
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  try {
    if (fs.existsSync(sourceDatabasePath)) {
      prepared =
        (await forkActiveOpenClawStateDatabaseReadSnapshot({ env: sourceEnv })) ??
        prepareSqliteReadOnlyLocationSync(sourceDatabasePath);
      privateRoot = path.dirname(prepared.location);
      cleanup = prepared.cleanupAsync;
    } else {
      privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-state-"));
      cleanup = async () => {
        try {
          await fs.promises.rm(privateRoot, { force: true, recursive: true });
          return true;
        } catch {
          return false;
        }
      };
    }
  } catch (error) {
    throw new DoctorLintStateSnapshotError(error);
  }
  const privateStateDir = path.join(privateRoot, "openclaw-state");
  // Only this owned copy is mutable; source-bound checks keep the enclosing read scope.
  const inspection = artifactPreservingReads.getStore();
  if (inspection) {
    inspection.privateRoots.add(privateStateDir);
  }
  const privateDatabasePath = resolveOpenClawStateSqlitePath({
    ...sourceEnv,
    OPENCLAW_STATE_DIR: privateStateDir,
  });
  const privateEnv = {
    ...sourceEnv,
    OPENCLAW_CONFIG_PATH: resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv)),
    OPENCLAW_STATE_DIR: privateStateDir,
  };
  const close = () =>
    withDoctorLintStateEnv(privateEnv, async () => {
      // Independent owners must both retire, even if one close fails. Retain
      // the snapshot on any failure, without losing an earlier detector error.
      const retirementErrors: unknown[] = [];
      try {
        closeAuthProfileReadPool({ kind: "root", rootPath: privateStateDir });
      } catch (error) {
        retirementErrors.push(error);
      }
      try {
        await closeOpenClawStateDatabaseByPathAsync(privateDatabasePath);
      } catch (error) {
        retirementErrors.push(error);
      }
      if (retirementErrors.length > 0) {
        throw new AggregateError(
          retirementErrors,
          retirementErrors.map((error) => scrubDoctorErrorMessage(error)).join("; "),
        );
      }
      if (!(await cleanup())) {
        const message = "Temporary doctor lint state snapshot cleanup did not complete.";
        if (!cleanupWarnings) {
          throw new Error(message);
        }
        // Only disposal of private bytes is advisory. Preserve the detector's outcome;
        // filtering its later error would lose real findings hidden by cleanup failure.
        recordSnapshotCleanupWarning(cleanupWarnings);
      }
    });
  try {
    fs.mkdirSync(path.dirname(privateDatabasePath), { recursive: true, mode: 0o700 });
    if (prepared) {
      for (const suffix of ["", "-journal", "-shm", "-wal"]) {
        const sourcePath = `${prepared.location}${suffix}`;
        if (fs.existsSync(sourcePath)) {
          fs.renameSync(sourcePath, `${privateDatabasePath}${suffix}`);
        }
      }
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new DoctorLintStateSnapshotError(
        new AggregateError(
          [error, cleanupError],
          `${scrubDoctorErrorMessage(error)}; ${scrubDoctorErrorMessage(cleanupError)}`,
        ),
      );
    }
    throw new DoctorLintStateSnapshotError(error);
  }
  return {
    close,
    run: <T>(inspect: (env: NodeJS.ProcessEnv) => Promise<T>) =>
      withDoctorLintStateEnv(privateEnv, () =>
        withPluginSourceCaptureStorage(captureStorage, () =>
          withDisposableOpenClawStateReads(privateDatabasePath, () =>
            withPluginInstallRoots({ ...installRoots, stateDir: privateStateDir }, () =>
              inspect(privateEnv),
            ),
          ),
        ),
      ),
  };
}

export function recordSnapshotCleanupWarning(warnings: HealthFinding[]): void {
  warnings.push({
    checkId: "core/doctor/lint-state-inspection",
    severity: "warning",
    requirement: "temporary-snapshot-cleanup",
    message: "Temporary doctor lint state snapshot cleanup did not complete.",
    fixHint: "Rerun `openclaw doctor --lint` after the update to check snapshot cleanup.",
  });
}

export async function withDoctorLintStateEnv<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
  selectorMode: "resolved" | "captured" = "resolved",
): Promise<T> {
  const stateDir = resolveStateDir(env);
  // A source scope must preserve absent selectors too: retained workers compare launch facts.
  const overrides =
    selectorMode === "captured"
      ? {
          OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
          OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
        }
      : {
          OPENCLAW_CONFIG_PATH: resolveConfigPath(env, stateDir),
          OPENCLAW_STATE_DIR: stateDir,
        };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  // Doctor checks run serially. Scope ambient auth/global-store owners together,
  // restoring the enclosing private view even when a detector throws.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
