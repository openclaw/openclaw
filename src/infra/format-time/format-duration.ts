import {
  formatDurationParts,
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
} from "./format-duration-internal.js";

export type FormatDurationSecondsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};

export type FormatDurationCompactOptions = {
  /** Show year units instead of folding them into days. Default: false */
  showYears?: boolean;
  /** Add space between units: "2m 5s" instead of "2m5s". Default: false */
  spaced?: boolean;
};

/**
 * Expand a number's shortest decimal string so BigInt construction always receives
 * plain decimal digits: values below 1e-6 or at or above 1e21 stringify in exponent
 * notation (e.g. "1e-7", "1e+21"), which BigInt() rejects.
 */
function expandDecimalString(value: number): string {
  const raw = String(value);
  const exponentIndex = raw.search(/[eE]/);
  if (exponentIndex === -1) {
    return raw;
  }
  const coefficient = raw.slice(0, exponentIndex);
  const exponent = Number.parseInt(raw.slice(exponentIndex + 1), 10);
  const [intPart = "0", fracPart = ""] = coefficient.split(".");
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exponent;
  if (pointPos <= 0) {
    return `0.${"0".repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return `${digits}${"0".repeat(pointPos - digits.length)}`;
  }
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

export function formatDurationSeconds(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  // Preserve the legacy toFixed precision coercion: fractional and non-finite
  // decimals truncate to an integer count (NaN -> 0) to keep the plugin-sdk
  // exported contract, and clamp to toFixed's supported 0..100 range so the
  // rendering stays clean for any accepted input.
  const requested = options.decimals ?? 1;
  const decimals = Number.isFinite(requested)
    ? Math.min(100, Math.max(0, Math.trunc(requested)))
    : 0;
  const unit = options.unit ?? "s";
  // Round once at the requested precision so float division noise cannot flip the
  // final digit (e.g. 1005ms -> "1.01s", not "1.00s"). Represent the input via its
  // shortest decimal string so fractional milliseconds survive to the final rounding
  // step (formatDurationPrecise(1004.9996) -> "1s"), and keep the fixed-point
  // arithmetic in BigInt so String() is always full decimal, never scientific
  // notation, across the supported precision range.
  const msStr = expandDecimalString(Math.max(0, ms));
  const [intPart = "0", fracPart = ""] = msStr.split(".");
  const fracFactor = 10n ** BigInt(fracPart.length);
  const msBig = BigInt(intPart) * fracFactor + BigInt(fracPart || "0");
  const scaled = (msBig * 10n ** BigInt(decimals) + fracFactor * 500n) / (fracFactor * 1000n);
  const divisor = 10n ** BigInt(decimals);
  const whole = scaled / divisor;
  const fraction = scaled % divisor;
  const trimmed =
    fraction === 0n
      ? `${whole}`
      : `${whole}.${String(fraction).padStart(decimals, "0").replace(/0+$/, "")}`;
  return unit === "seconds" ? `${trimmed} seconds` : `${trimmed}s`;
}

/** Precise decimal-seconds output: "500ms" or "1.23s". Input is milliseconds. */
export function formatDurationPrecise(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const roundedMs = Math.max(0, Math.round(ms));
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  return formatDurationSeconds(ms, {
    decimals: options.decimals ?? 2,
    unit: options.unit ?? "s",
  });
}

/**
 * Compact compound duration: "500ms", "45s", "2m5s", "1h30m".
 * With `spaced`: "45s", "2m 5s", "1h 30m".
 * Omits trailing zero components: "1m" not "1m 0s", "2h" not "2h 0m".
 * Returns undefined for null/undefined/non-finite/non-positive input.
 */
export function formatDurationCompact(
  ms?: number | null,
  options?: FormatDurationCompactOptions,
): string | undefined {
  const parts = resolveCompactDurationParts(ms, options?.showYears);
  const formatted = parts && formatDurationParts(parts);
  return options?.spaced ? formatted : formatted?.replaceAll(" ", "");
}

/**
 * Rounded single-unit duration for display: "500ms", "5s", "3m", "2h", "5d".
 * Returns fallback string for null/undefined/non-finite input.
 */
export function formatDurationHuman(ms?: number | null, fallback = "n/a"): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return formatDurationParts(resolveSingleUnitDurationParts(ms));
}
