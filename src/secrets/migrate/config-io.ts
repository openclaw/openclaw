import { createConfigIO } from "../../config/config.js";

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

export function createSecretsMigrationConfigIO(params: { env: NodeJS.ProcessEnv }) {
  // Migration output is owned by the CLI command so --json remains machine-parseable.
  return createConfigIO({
    env: params.env,
    logger: silentConfigIoLogger,
  });
}
