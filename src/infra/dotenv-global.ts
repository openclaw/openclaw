import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  loadGlobalRuntimeDotEnvFilesCore,
  loadGlobalRuntimeDotEnvFilesAsyncCore,
  type GlobalRuntimeDotEnvOptions as CoreGlobalRuntimeDotEnvOptions,
} from "./dotenv-global-core.js";

export {
  readDotEnvFileCore as readDotEnvFile,
  readDotEnvFileAsyncCore as readDotEnvFileAsync,
} from "./dotenv-global-core.js";

const logger = createSubsystemLogger("infra:dotenv");

type GlobalRuntimeDotEnvOptions = Omit<CoreGlobalRuntimeDotEnvOptions, "onWarning">;

/** Load global runtime dotenv files with first-wins precedence, defaulting to `process.env`. */
export function loadGlobalRuntimeDotEnvFiles(opts: GlobalRuntimeDotEnvOptions = {}) {
  return loadGlobalRuntimeDotEnvFilesCore({ ...opts, onWarning: logger.warn });
}

/** Read global runtime dotenv files asynchronously into a caller-owned environment. */
export async function loadGlobalRuntimeDotEnvFilesAsync(
  opts: GlobalRuntimeDotEnvOptions & { env: NodeJS.ProcessEnv },
) {
  return await loadGlobalRuntimeDotEnvFilesAsyncCore({ ...opts, onWarning: logger.warn });
}
