import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { Question } from "../../../packages/gateway-protocol/src/index.js";
import { normalizeQuestionSecretStoreFields } from "./question-prompt-secret-store.ts";

const MAX_HEADER_GRAPHEMES = 12;

function clampHeaderGraphemes(header: string): string {
  const segments = [...new Intl.Segmenter().segment(header)];
  if (segments.length <= MAX_HEADER_GRAPHEMES) {
    return header;
  }
  return segments
    .slice(0, MAX_HEADER_GRAPHEMES)
    .map((part) => part.segment)
    .join("");
}

export function parseQuestion(value: unknown): Question | null {
  if (!isRecord(value)) {
    return null;
  }
  const questionId = readNonEmptyString(value.questionId);
  const header = typeof value.header === "string" ? value.header : null;
  const question = readNonEmptyString(value.question);
  if (!questionId || !/^[a-z][a-z0-9_]*$/.test(questionId) || header === null || !question) {
    return null;
  }
  // Clamp instead of reject: the gateway enforces the 12-cap with grapheme
  // semantics, and any re-count here (UTF-16, code points, or a second grapheme
  // impl) can disagree at the boundary and silently drop the whole prompt.
  const clampedHeader = clampHeaderGraphemes(header);
  if (!Array.isArray(value.options) || value.options.length > 4) {
    return null;
  }
  const options = value.options.flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const label = readNonEmptyString(option.label);
    if (!label || (option.description !== undefined && typeof option.description !== "string")) {
      return [];
    }
    return [
      {
        label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      },
    ];
  });
  if (options.length !== value.options.length) {
    return null;
  }
  const url = readNonEmptyString(value.url);
  if (value.url !== undefined) {
    if (!url || !hasHttpUrlPrefix(url)) {
      return null;
    }
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        return null;
      }
    } catch {
      return null;
    }
  }
  for (const field of ["multiSelect", "isOther"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      return null;
    }
  }
  const secretStoreFields = normalizeQuestionSecretStoreFields(value);
  if (!secretStoreFields) {
    return null;
  }
  return {
    questionId,
    header: clampedHeader,
    question,
    options,
    ...(url ? { url } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(typeof value.isOther === "boolean" ? { isOther: value.isOther } : {}),
    ...secretStoreFields,
  };
}
