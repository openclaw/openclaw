import { z } from "zod";
import {
  hasConfiguredSecretInput,
  isSecretRef,
  coerceSecretRef,
  resolveSecretInputString,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { buildSecretInputSchema } from "./secret-input-schema.js";

export type {
  SecretInput,
  SecretInputStringResolution,
  SecretInputStringResolutionMode,
} from "../config/types.secrets.js";
export {
  buildSecretInputSchema,
  coerceSecretRef,
  hasConfiguredSecretInput,
  isSecretRef,
  resolveSecretInputString,
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
  normalizeSecretInputString,
};

export function hasMatchingSecretInput(left: unknown, right: unknown): boolean {
  const leftString = normalizeSecretInputString(left);
  const rightString = normalizeSecretInputString(right);
  if (leftString && rightString) {
    return leftString === rightString;
  }

  const leftRef = coerceSecretRef(left);
  const rightRef = coerceSecretRef(right);
  if (!leftRef || !rightRef) {
    return false;
  }

  return (
    leftRef.source === rightRef.source &&
    leftRef.provider === rightRef.provider &&
    leftRef.id === rightRef.id
  );
}

/** Optional version of the shared secret-input schema. */
export function buildOptionalSecretInputSchema() {
  return buildSecretInputSchema().optional();
}

/** Array version of the shared secret-input schema. */
export function buildSecretInputArraySchema() {
  return z.array(buildSecretInputSchema());
}
