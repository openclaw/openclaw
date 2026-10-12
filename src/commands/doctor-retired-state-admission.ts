import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { assertNoRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import {
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery,
  listReferencedLegacyOAuthSidecarPaths,
} from "./doctor-auth-legacy-paths.js";

/** Refuse unsupported sources before Doctor stops the Gateway or changes shared state. */
export function assertDoctorRetiredStateAdmission(): void {
  assertNoRetiredRuntimeStateFiles(resolveStateDir(process.env));
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery({ env: process.env });
  const { config, env } = readCurrentConfigForResolution();
  assertNoRetiredStateFiles(
    "OAuth credential sidecars",
    listReferencedLegacyOAuthSidecarPaths(env, config),
  );
}
