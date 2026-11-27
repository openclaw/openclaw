import type { DictationCleanupPolicy } from "../../app/settings-contract.ts";

export type DictationCleanupSource = {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
  readonly isFinal: boolean;
  readonly locale?: string | null;
};

export type CleanupReason =
  | "off"
  | "not-final"
  | "unsupported-policy"
  | "unsupported-locale"
  | "invalid-source"
  | "semantic-unavailable";

const MAX_SOURCE_BYTES = 32 * 1024;
export function isCleanupSourceBounded(text: string): boolean {
  return (
    text.length <= MAX_SOURCE_BYTES && new TextEncoder().encode(text).length <= MAX_SOURCE_BYTES
  );
}

/** Classify a bounded review source without proposing or validating semantic edits. */
export function dictationReviewReason(
  source: DictationCleanupSource,
  policy: DictationCleanupPolicy,
): CleanupReason {
  if (policy.version !== 1 || (policy.mode !== "off" && policy.mode !== "conservative")) {
    return "unsupported-policy";
  }
  if (policy.mode === "off") {
    return "off";
  }
  if (!source.isFinal) {
    return "not-final";
  }
  const locale = source.locale ?? policy.locale;
  if (!locale || !/^en(?:-[a-z0-9]+)*$/i.test(locale)) {
    return "unsupported-locale";
  }
  if (!source.id || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    return "invalid-source";
  }
  return "semantic-unavailable";
}
