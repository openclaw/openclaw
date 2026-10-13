import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDoctorPluginMetadataSnapshotScope } from "./plugin-metadata-snapshot-scope.js";

/** Direct repair fixtures enter the same native metadata owner as the Doctor command. */
export function withDoctorPluginMetadataForTest<T>(
  config: OpenClawConfig,
  run: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const scope = createDoctorPluginMetadataSnapshotScope({ env });
  onTestFinished(() => scope[Symbol.asyncDispose]());
  return scope.run({ config }, run);
}
