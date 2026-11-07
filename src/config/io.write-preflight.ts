import { formatErrorMessage } from "../infra/errors.js";
import { ConfigRuntimeRefreshError, type ConfigWriteOptions } from "./io.types.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function preflightConfigRuntimeWrite(
  configPath: string,
  nextSourceConfig: OpenClawConfig,
  refreshOptions: ConfigWriteOptions["runtimeRefresh"],
) {
  return preflightRuntimeSnapshotWrite({
    nextSourceConfig,
    refreshOptions,
    formatRefreshError: (error) => formatErrorMessage(error),
    createRefreshError: (detail, cause) =>
      new ConfigRuntimeRefreshError(
        `Config write blocked before committing ${configPath}: active SecretRef resolution failed: ${detail}`,
        { cause },
      ),
  });
}
