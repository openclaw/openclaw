import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";
import { withTempHome } from "../config/test-helpers.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { withEnvAsync } from "../test-utils/env.js";

/** Retain inspection imports across repair and reread; changed launch environments still retire the child. */
export function useDoctorConfigPreflightHome() {
  const workers = createSqliteReadOnlyWorkerScope();
  afterAll(() => workers.close());
  return <T>(run: (home: string) => Promise<T>): Promise<T> =>
    workers.run(() => withDoctorConfigPreflightHome(run));
}

/** Keep real preflight fixtures from provisioning plugins for the developer's credentials. */
export async function withDoctorConfigPreflightHome<T>(
  run: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHome(async (home) => {
    const control = path.join(home, "update-control");
    await fs.mkdir(control, { mode: 0o700 });
    const temporaryRoot = vi
      .spyOn(temporaryState, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(control);
    const providerEnv = Object.fromEntries(
      listKnownProviderAuthEnvVarNamesCore({ config: {}, env: process.env }).map((key) => [
        key,
        undefined,
      ]),
    );
    try {
      expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
        path.join(control, "managed-update-handoffs.sqlite"),
      );
      // Fixture-owned coordinator handles must close before Windows removes the home.
      return await withStateDatabaseCoordinatorRuntimeDirectory(
        path.join(home, "coordinator-runtime"),
        () => withEnvAsync(providerEnv, () => run(home)),
      );
    } finally {
      temporaryRoot.mockRestore();
    }
  });
}
