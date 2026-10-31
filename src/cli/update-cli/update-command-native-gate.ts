import { mergeProcessEnv } from "../../infra/process-env.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "../../infra/runtime-worker-generation.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";

/** Keep Node startup hooks behind admission without changing the native payload's environment. */
export function prepareUpdateCommandNativeGate(
  ticket: string,
  sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>,
  platform: NodeJS.Platform = process.platform,
) {
  const env = mergeProcessEnv(sources, platform);
  const key = Object.keys(env).find((name) =>
    platform === "win32" ? name.toUpperCase() === "NODE_OPTIONS" : name === "NODE_OPTIONS",
  );
  const input = JSON.stringify([ticket, key === undefined ? null : [key, env[key]]]);
  if (key !== undefined) {
    delete env[key];
  }
  const { moduleUrl } = captureRuntimeWorkerSource(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateNativeGate),
  );
  return {
    argv: [
      process.execPath,
      ...resolveRuntimeWorkerArgv(moduleUrl),
      String(Buffer.byteLength(input)),
    ],
    env,
    input,
  };
}
