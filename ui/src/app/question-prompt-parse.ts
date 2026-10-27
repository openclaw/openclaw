import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { Question } from "../../../packages/gateway-protocol/src/index.js";
import { takeGraphemes } from "../lib/graphemes.ts";

const MAX_HEADER_GRAPHEMES = 12;

export function parseQuestion(value: Question): Question | null {
  const questionId = readNonEmptyString(value.questionId);
  const question = readNonEmptyString(value.question);
  if (!questionId || !question) {
    return null;
  }
  // Clamp instead of reject: the gateway enforces the 12-cap with grapheme
  // semantics, and any re-count here (UTF-16, code points, or a second grapheme
  // impl) can disagree at the boundary and silently drop the whole prompt.
  const clampedHeader = takeGraphemes(value.header, MAX_HEADER_GRAPHEMES);
  // The Gateway validates media and store bindings before publishing; the UI
  // only normalizes their visible text.
  const options = value.options.map((option) => ({ ...option, label: option.label.trim() }));
  if (options.some((option) => !option.label)) {
    return null;
  }
  const url = readNonEmptyString(value.url);
  if (value.url !== undefined) {
    if (!url || !hasHttpUrlPrefix(url)) {
      return null;
    }
    const parsed = URL.parse(url);
    if (!parsed || parsed.username || parsed.password) {
      return null;
    }
  }
  // Replacement metadata comes from stored entries, outside request validation.
  const existing = value.secretStoreExisting;
  const updatedBy = readNonEmptyString(existing?.updatedBy);
  if (
    existing &&
    (asSafeIntegerInRange(existing.updatedAtMs, { min: 0 }) === undefined ||
      (existing.updatedBy !== undefined && !updatedBy))
  ) {
    return null;
  }
  return {
    ...value,
    questionId,
    header: clampedHeader,
    question,
    options,
    ...(url ? { url } : {}),
    ...(existing
      ? {
          secretStoreExisting: {
            updatedAtMs: existing.updatedAtMs,
            ...(updatedBy ? { updatedBy } : {}),
          },
        }
      : {}),
  };
}
