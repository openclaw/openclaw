import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { getPluginResolutionPolicy } from "./plugin-native-resolution.js";

/** Keep plugin preparation on the same module-resolution policy as its caller. */
export function resolvePluginPreparationExecArgv(url: URL): string[] {
  const policy = getPluginResolutionPolicy();
  return [
    ...resolveRuntimeWorkerThreadExecArgv(url),
    ...[...policy.conditions].map((condition) => `--conditions=${condition}`),
    policy.addons ? "--addons" : "--no-addons",
    ...(process.versions.bun
      ? []
      : [
          policy.requireModule
            ? "--experimental-require-module"
            : "--no-experimental-require-module",
        ]),
    ...(policy.preserveSymlinks ? ["--preserve-symlinks"] : []),
  ];
}
