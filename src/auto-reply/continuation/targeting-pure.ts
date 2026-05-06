import { normalizeOptionalString } from "../../shared/string-coerce.js";

export const CONTINUATION_DELEGATE_FANOUT_MODES = ["tree", "all"] as const;

export type ContinuationDelegateFanoutMode = (typeof CONTINUATION_DELEGATE_FANOUT_MODES)[number];

export type ContinuationDelegateTargeting = {
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
};

export function normalizeContinuationTargetKey(value?: string): string | undefined {
  return normalizeOptionalString(value);
}

export function normalizeContinuationTargetKeys(values?: readonly string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeContinuationTargetKey(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    keys.push(normalized);
  }
  return keys;
}

export function hasContinuationDelegateTargeting(
  targeting: ContinuationDelegateTargeting,
): boolean {
  return Boolean(
    normalizeContinuationTargetKey(targeting.targetSessionKey) ||
    normalizeContinuationTargetKeys(targeting.targetSessionKeys).length > 0 ||
    targeting.fanoutMode,
  );
}
