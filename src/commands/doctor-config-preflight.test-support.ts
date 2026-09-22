import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { withTempHome } from "../config/test-helpers.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";
import { withEnvAsync } from "../test-utils/env.js";

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
      listKnownProviderAuthEnvVarNames({ config: {}, env: process.env }).map((key) => [
        key,
        undefined,
      ]),
    );
    try {
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
