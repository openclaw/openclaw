// Loads global dotenv files with runtime logging for diagnostics.
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  loadGlobalRuntimeDotEnvFilesCore,
  loadGlobalRuntimeDotEnvFilesAsyncCore,
  readDotEnvFileCore,
  readDotEnvFileAsyncCore,
  type GlobalRuntimeDotEnvOptions as CoreGlobalRuntimeDotEnvOptions,
  type LoadedDotEnvFile,
  type ReadDotEnvFileOptions as CoreReadDotEnvFileOptions,
} from "./dotenv-global-core.js";

const logger = createSubsystemLogger("infra:dotenv");

type GlobalRuntimeDotEnvOptions = Omit<CoreGlobalRuntimeDotEnvOptions, "onWarning">;
type ReadDotEnvFileOptions = Omit<CoreReadDotEnvFileOptions, "onWarning">;

export function readDotEnvFile(params: ReadDotEnvFileOptions): LoadedDotEnvFile | null {
  return readDotEnvFileCore({ ...params, onWarning: logger.warn });
}

export async function readDotEnvFileAsync(
  params: ReadDotEnvFileOptions,
): Promise<LoadedDotEnvFile | null> {
  return await readDotEnvFileAsyncCore({ ...params, onWarning: logger.warn });
}

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
