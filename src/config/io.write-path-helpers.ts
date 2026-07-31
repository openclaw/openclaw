import { INCLUDE_KEY } from "./includes.js";

export function hasOwnIncludeDirective(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.hasOwn(value, INCLUDE_KEY);
}

export function readConfigPath(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setConfigPath(
  value: unknown,
  segments: readonly string[],
  nextValue: unknown,
): unknown {
  if (segments.length === 0) {
    return structuredClone(nextValue);
  }
  const [head, ...tail] = segments;
  if (!head) {
    return value;
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...record,
    [head]: setConfigPath((record as Record<string, unknown>)[head], tail, nextValue),
  };
}

export function hasIncludedGatewayModeOwner(value: unknown): boolean {
  if (hasOwnIncludeDirective(value)) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const gateway = (value as Record<string, unknown>).gateway;
  if (hasOwnIncludeDirective(gateway)) {
    return true;
  }
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return false;
  }
  return hasOwnIncludeDirective((gateway as Record<string, unknown>).mode);
}
