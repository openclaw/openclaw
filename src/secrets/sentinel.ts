import { randomBytes } from "node:crypto";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

const SECRET_SENTINEL_PREFIX = "oc-sent-v1-";
const SECRET_SENTINEL_SOURCE = `${SECRET_SENTINEL_PREFIX}[0-9a-f]{24}`;

export const SECRET_SENTINEL_PATTERN = new RegExp(SECRET_SENTINEL_SOURCE, "g");

const valuesBySentinel = new Map<string, string>();
const sentinelsByValueAndLabel = new Map<string, Map<string, string>>();

function secretSentinelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.OPENCLAW_SECRET_SENTINELS?.trim().toLowerCase();
  return configured !== "off" && configured !== "0" && configured !== "false";
}

export function looksLikeSecretSentinel(value: string): boolean {
  return new RegExp(`^${SECRET_SENTINEL_SOURCE}$`).test(value);
}

/** Mints one stable process-local sentinel for a secret value and label. */
export function mintSecretSentinel(value: string, meta: { label: string }): string {
  registerSecretValueForRedaction(value);
  if (!secretSentinelsEnabled()) {
    return value;
  }
  const byLabel = sentinelsByValueAndLabel.get(value) ?? new Map<string, string>();
  const existing = byLabel.get(meta.label);
  if (existing) {
    return existing;
  }
  let sentinel: string;
  do {
    sentinel = `${SECRET_SENTINEL_PREFIX}${randomBytes(12).toString("hex")}`;
  } while (valuesBySentinel.has(sentinel));
  byLabel.set(meta.label, sentinel);
  sentinelsByValueAndLabel.set(value, byLabel);
  valuesBySentinel.set(sentinel, value);
  return sentinel;
}

/** Resolves a process-local sentinel without exposing the registry itself. */
export function resolveSecretSentinel(sentinel: string): string | undefined {
  const value = valuesBySentinel.get(sentinel);
  if (value !== undefined) {
    // Refresh the bounded redaction registry whenever a live sentinel is used.
    registerSecretValueForRedaction(value);
  }
  return value;
}

/** Swaps every known sentinel substring and reports unknown sentinel-shaped values. */
export function swapSecretSentinelsInText(text: string): { text: string; unknown: string[] } {
  if (!text.includes(SECRET_SENTINEL_PREFIX)) {
    return { text, unknown: [] };
  }
  const unknown = new Set<string>();
  const swapped = text.replace(new RegExp(SECRET_SENTINEL_SOURCE, "g"), (sentinel) => {
    const value = resolveSecretSentinel(sentinel);
    if (value === undefined) {
      unknown.add(sentinel);
      return sentinel;
    }
    return value;
  });
  return { text: swapped, unknown: [...unknown] };
}
