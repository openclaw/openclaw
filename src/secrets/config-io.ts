import { createConfigIO } from "../config/config.js";
import type { ConfigWriteOptions, ConfigWriteResult } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ConfigIO = ReturnType<typeof createConfigIO>;
type SecretsConfigIO = Pick<
  ConfigIO,
  "readConfigFileSnapshot" | "readConfigFileSnapshotForWrite"
> & {
  writeConfigFile: (
    cfg: OpenClawConfig,
    options?: ConfigWriteOptions,
  ) => Promise<ConfigWriteResult>;
};

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

export function createSecretsConfigIO(params: { env: NodeJS.ProcessEnv }): SecretsConfigIO {
  // Secrets command output is owned by the CLI command so --json stays machine-parseable.
  return createConfigIO({
    env: params.env,
    logger: silentConfigIoLogger,
  });
}
