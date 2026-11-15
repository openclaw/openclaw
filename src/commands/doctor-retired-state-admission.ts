import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { listExistingRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { listRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import {
  inspectLegacyOAuthSidecarsBeforeConfigRecovery,
  listReferencedLegacyOAuthSidecarPaths,
} from "./doctor-auth-legacy-paths.js";

/** Inspect source access before Doctor stops the Gateway; Doctor owns forward migration. */
export function assertDoctorRetiredStateAdmission(): void {
  listExistingRetiredStateFiles(listRetiredRuntimeStateFiles(resolveStateDir(process.env)));
  inspectLegacyOAuthSidecarsBeforeConfigRecovery({ env: process.env });
  const { config, env } = readCurrentConfigForResolution();
  listExistingRetiredStateFiles(listReferencedLegacyOAuthSidecarPaths(env, config));
}
