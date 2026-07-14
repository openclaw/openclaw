/** Config IO adapter used by secrets apply/configure flows. */
import { createConfigIO } from "../config/config.js";
import type { ConfigMutationIO } from "../config/config.js";

type SecretsConfigIO = Pick<
  ReturnType<typeof createConfigIO>,
  "readConfigFileSnapshot" | "readConfigFileSnapshotForWrite"
> &
  Pick<ConfigMutationIO, "writeConfigFile">;

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

/**
 * Creates config I/O for secrets commands with config-loader logging suppressed.
 */
export function createSecretsConfigIO(params: { env: NodeJS.ProcessEnv }): SecretsConfigIO {
  // Secrets command output is owned by the CLI command so --json stays machine-parseable.
  return createConfigIO({
    env: params.env,
    logger: silentConfigIoLogger,
  });
}
