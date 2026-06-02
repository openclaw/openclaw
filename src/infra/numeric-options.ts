import {
  resolveIntegerOption as resolveSharedIntegerOption,
  resolveNonNegativeIntegerOption as resolveSharedNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";

/** Normalizes numeric options that must floor to zero or a positive integer. */
export function resolveNonNegativeIntegerOption(value: number, fallback: number): number {
  return resolveSharedNonNegativeIntegerOption(value, fallback);
}

/** Normalizes integer options that must respect a caller-provided minimum. */
export function resolveIntegerOption(
  value: number,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
