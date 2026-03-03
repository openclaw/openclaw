import { isNonEmptyString, isRecord } from "./shared.js";

export type SecretExpectedResolvedValue = "string" | "string-or-object";

export function isExpectedResolvedSecretValue(
  value: unknown,
  expected: SecretExpectedResolvedValue,
): boolean {
  if (expected === "string") {
    return isNonEmptyString(value);
  }
  return isNonEmptyString(value) || isRecord(value);
}

export function hasConfiguredPlaintextSecretValue(
  value: unknown,
  expected: SecretExpectedResolvedValue,
): boolean {
  if (expected === "string") {
    return isNonEmptyString(value);
  }
  return isNonEmptyString(value) || (isRecord(value) && Object.keys(value).length > 0);
}

export function assertExpectedResolvedSecretValue(params: {
  value: unknown;
  expected: SecretExpectedResolvedValue;
  errorMessage: string;
}): void {
  if (!isExpectedResolvedSecretValue(params.value, params.expected)) {
    throw new Error(params.errorMessage);
  }
}
