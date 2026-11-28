import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const legacyCronAccountTextPatterns = [
  '%"inferenceBinding"%',
  '%"ownerTransferPending"%',
  String.raw`%\u%`,
] as const;

export type LegacyCronInferenceBinding = {
  version: 1;
  provider: string;
  profileId: string;
  authorizationId: string;
  authRequirement: "api-key" | "subscription";
  runtime?: string;
};

/** The model route and credential lifetime that Doctor verified for one saved job. */
export type CronInferenceBindingConversion = {
  binding: LegacyCronInferenceBinding;
  authorizationId: string;
  model: string;
  fallbacks?: string[];
};

export function applyCronInferenceModelPin(
  payload: object,
  conversion: CronInferenceBindingConversion,
) {
  return {
    ...payload,
    model: conversion.model,
    ...(conversion.binding.runtime ? { modelRuntime: conversion.binding.runtime } : {}),
    ...(conversion.fallbacks ? { fallbacks: conversion.fallbacks } : {}),
  };
}

export function isLegacyCronInferenceBinding(value: unknown): value is LegacyCronInferenceBinding {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.provider === "string" &&
    typeof value.profileId === "string" &&
    typeof value.authorizationId === "string" &&
    (value.authRequirement === "api-key" || value.authRequirement === "subscription") &&
    (value.runtime === undefined ||
      (typeof value.runtime === "string" && value.runtime.trim().length > 0))
  );
}

export function hasLegacyCronInferenceAccount(candidate: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(candidate, "inferenceBinding") || Object.hasOwn(candidate, "ownerTransferPending")
  );
}

export function hasLegacyCronInferenceAccountJson(jobJson: string): boolean {
  const definition = safeParseJsonRecord(jobJson);
  return definition !== undefined && hasLegacyCronInferenceAccount(definition);
}
