import { createConfigIO } from "../config/config.js";

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

export function createSecretsConfigIO(params: {
  env: NodeJS.ProcessEnv;
  configPath?: string;
  logger?: { error: (message: string) => void; warn: (message: string) => void };
}) {
  // Secrets command output is owned by the CLI command so --json stays machine-parseable.
  return createConfigIO({
    env: params.env,
    configPath: params.configPath,
    logger: params.logger ?? silentConfigIoLogger,
  });
}
