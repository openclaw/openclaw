import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import { projectSourceOntoRuntimeShape } from "./io.write-prepare.js";
import { applyMergePatch } from "./merge-patch.js";
import { getRuntimeConfigSourcePair, registerRuntimeConfigSourcePair } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

function containsSecretRef(value: unknown): boolean {
  if (isSecretRef(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretRef);
  }
  return isRecord(value) && Object.values(value).some(containsSecretRef);
}

function restoreSecretRefs(source: unknown, target: unknown): unknown {
  if (isSecretRef(source)) {
    return source;
  }
  if (Array.isArray(source) && Array.isArray(target)) {
    return target.map((value, index) => restoreSecretRefs(source[index], value));
  }
  if (!isRecord(source) || !isRecord(target)) {
    return target;
  }
  const restored = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (containsSecretRef(sourceValue) && Object.hasOwn(restored, key)) {
      restored[key] = restoreSecretRefs(sourceValue, restored[key]);
    }
  }
  return restored;
}

function hasSecretRefRuntimeMismatch(
  source: unknown,
  runtime: unknown,
  candidate: unknown,
): boolean {
  if (isSecretRef(source)) {
    return !isDeepStrictEqual(runtime, candidate);
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(runtime) || !Array.isArray(candidate)) {
      return containsSecretRef(source);
    }
    return source.some((value, index) =>
      hasSecretRefRuntimeMismatch(value, runtime[index], candidate[index]),
    );
  }
  if (!isRecord(source)) {
    return false;
  }
  if (!isRecord(runtime) || !isRecord(candidate)) {
    return containsSecretRef(source);
  }
  return Object.entries(source).some(([key, value]) =>
    hasSecretRefRuntimeMismatch(value, runtime[key], candidate[key]),
  );
}

/** Applies a scoped merge while retaining only explicit runtime-to-source provenance. */
export function applyMergePatchToPairedRuntimeConfig(params: {
  runtimeConfig: OpenClawConfig;
  patch: OpenClawConfig;
}): OpenClawConfig {
  const config = applyMergePatch(params.runtimeConfig, params.patch) as OpenClawConfig;
  const sourceConfig = getRuntimeConfigSourcePair(params.runtimeConfig);
  if (!sourceConfig) {
    return config;
  }
  if (hasSecretRefRuntimeMismatch(sourceConfig, params.runtimeConfig, config)) {
    throw new Error("Cannot override a resolved SecretRef through a runtime config merge.");
  }
  const projectedSource = projectSourceOntoRuntimeShape(
    sourceConfig,
    params.runtimeConfig,
  ) as OpenClawConfig;
  const patchedSource = applyMergePatch(projectedSource, params.patch) as OpenClawConfig;
  // Merge patches replace arrays atomically, so restore authored refs after scoped changes.
  const pairedSource = restoreSecretRefs(projectedSource, patchedSource) as OpenClawConfig;
  registerRuntimeConfigSourcePair(config, pairedSource);
  return config;
}

/** Returns authored config only for a runtime object with an explicit source pairing. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  return getRuntimeConfigSourcePair(config) ?? config;
}
