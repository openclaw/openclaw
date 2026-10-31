import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { getPluginConfiguredConditions } from "./plugin-native-resolution.js";

/** Keep plugin preparation on the same module-resolution policy as its caller. */
export function resolvePluginPreparationExecArgv(url: URL): string[] {
  return [
    ...resolveRuntimeWorkerThreadExecArgv(url),
    ...[...getPluginConfiguredConditions()].map((condition) => `--conditions=${condition}`),
    ...(process.execArgv.includes("--no-addons") ? ["--no-addons"] : []),
    ...(process.execArgv.includes("--preserve-symlinks") ? ["--preserve-symlinks"] : []),
  ];
}
