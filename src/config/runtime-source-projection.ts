import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import { createMergePatch, projectSourceOntoRuntimeShape } from "./io.write-prepare.js";
import { applyMergePatch } from "./merge-patch.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  registerRuntimeConfigSourcePair,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

function isCompatibleTopLevelRuntimeProjectionShape(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return false;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return false;
    }
  }
  return true;
}

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

/** Projects against an explicit pair only when every resolved SecretRef value still matches. */
export function projectConfigOntoPairedRuntimeSourceSnapshot(params: {
  config: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}): OpenClawConfig | undefined {
  if (hasSecretRefRuntimeMismatch(params.sourceConfig, params.runtimeConfig, params.config)) {
    return undefined;
  }
  if (params.config === params.runtimeConfig) {
    registerRuntimeConfigSourcePair(params.config, params.sourceConfig);
    return params.sourceConfig;
  }
  const projectedSource = projectSourceOntoRuntimeShape(
    params.sourceConfig,
    params.runtimeConfig,
  ) as OpenClawConfig;
  const runtimePatch = createMergePatch(params.runtimeConfig, params.config);
  const patchedSource = applyMergePatch(projectedSource, runtimePatch) as OpenClawConfig;
  // Merge patches replace arrays atomically, so restore authored refs after scoped changes.
  const pairedSource = restoreSecretRefs(projectedSource, patchedSource) as OpenClawConfig;
  registerRuntimeConfigSourcePair(params.config, pairedSource);
  return pairedSource;
}

/** Projects a runtime-derived config back onto the active authored source snapshot. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    registerRuntimeConfigSourcePair(config, runtimeConfigSourceSnapshot);
    return runtimeConfigSourceSnapshot;
  }
  if (
    !isCompatibleTopLevelRuntimeProjectionShape({
      runtimeSnapshot: runtimeConfigSnapshot,
      candidate: config,
    })
  ) {
    return config;
  }
  if (hasSecretRefRuntimeMismatch(runtimeConfigSourceSnapshot, runtimeConfigSnapshot, config)) {
    return config;
  }
  const projectedSource = projectSourceOntoRuntimeShape(
    runtimeConfigSourceSnapshot,
    runtimeConfigSnapshot,
  ) as OpenClawConfig;
  const runtimePatch = createMergePatch(runtimeConfigSnapshot, config);
  const patchedSource = applyMergePatch(projectedSource, runtimePatch) as OpenClawConfig;
  const pairedSource = restoreSecretRefs(projectedSource, patchedSource) as OpenClawConfig;
  registerRuntimeConfigSourcePair(config, pairedSource);
  return pairedSource;
}
