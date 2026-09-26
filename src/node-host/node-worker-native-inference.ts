import path from "node:path";
import { readSecretFileSync } from "../infra/secret-file.js";
import type { NativeInferenceStartup } from "../worker/native-inference-startup.js";
import {
  NativeRuntimeConfigSchema,
  type NativeRuntimeConfig,
} from "../worker/native-runtime-config.js";

/** The trusted supervisor captures file bytes and named credentials before yielding. */
export function snapshotNodeWorkerNativeInference(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv,
): NativeInferenceStartup | undefined {
  if (configPath === undefined) {
    return undefined;
  }
  if (process.platform === "win32") {
    throw new Error(
      "Worker-local inference is not supported on Windows yet; use a Gateway-inference profile and leave nodeHost.workerRuns.nativeInferenceConfig unset.",
    );
  }
  if (!path.isAbsolute(configPath) || configPath.includes("\0")) {
    throw new Error("Node worker native inference configuration requires an absolute path");
  }
  let config: NativeRuntimeConfig;
  try {
    config = NativeRuntimeConfigSchema.parse(
      JSON.parse(
        readSecretFileSync(configPath, "Node worker native inference configuration", {
          maxBytes: 1024 * 1024,
        }),
      ),
    );
  } catch {
    // Parser and filesystem errors can contain source bytes or operator paths.
    throw new Error(
      "Node worker native inference configuration is invalid or unavailable. Each workspace requires an explicit models allowlist ([] denies all) using configured model references.",
    );
  }
  const credentials = Object.fromEntries(
    [...new Set(config.models.map((model) => model.apiKeyEnv))].map((name) => {
      const value = Object.hasOwn(env, name) ? env[name] : undefined;
      if (!value?.trim()) {
        throw new Error("Node worker native inference credential is unavailable");
      }
      return [name, value];
    }),
  );
  return { config, credentials };
}

/** Diagnostic scrubbing conservatively covers startup headers, including ordinary metadata. */
export function nodeWorkerNativeInferenceSecrets(startup: NativeInferenceStartup): string[] {
  return [
    ...Object.values(startup.credentials),
    ...startup.config.models.flatMap((model) => Object.values(model.headers ?? {})),
  ].filter((value) => value.length > 0);
}
