import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { Question } from "../../../packages/gateway-protocol/src/index.js";
import {
  isQuestionThumbnail,
  readQuestionResourceInput,
  readQuestionResourcePreview,
} from "../../../packages/gateway-protocol/src/question-media.js";
import { takeGraphemes } from "../lib/graphemes.ts";
import { normalizeQuestionSecretStoreFields } from "./question-prompt-secret-store.ts";

const MAX_HEADER_GRAPHEMES = 12;

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
  const clampedHeader = takeGraphemes(header, MAX_HEADER_GRAPHEMES);
  if (value.presentation !== undefined && value.presentation !== "form") {
    return null;
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length > (value.presentation === "form" ? 64 : 4)
  ) {
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
    if (option.thumbnail !== undefined && !isQuestionThumbnail(option.thumbnail)) {
      return [];
    }
    if (
      option.value !== undefined &&
      (typeof option.value !== "string" || !option.value || option.value.length > 4096)
    ) {
      return [];
    }
    const preview =
      option.preview === undefined ? undefined : readQuestionResourcePreview(option.preview);
    if (
      (option.preview !== undefined && !preview) ||
      (option.resourceUri !== undefined &&
        (typeof option.resourceUri !== "string" || option.resourceUri.length > 2048))
    ) {
      return [];
    }
    return [
      {
        label,
        ...(typeof option.value === "string" ? { value: option.value } : {}),
        ...(preview ? { preview } : {}),
        ...(typeof option.resourceUri === "string" ? { resourceUri: option.resourceUri } : {}),
        ...(typeof option.thumbnail === "string" ? { thumbnail: option.thumbnail } : {}),
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
  if (value.answerFormat !== undefined && value.answerFormat !== "lines") {
    return null;
  }
  const defaultAnswers =
    Array.isArray(value.defaultAnswers) &&
    value.defaultAnswers.every(
      (entry): entry is string => typeof entry === "string" && entry.length <= 4096,
    )
      ? value.defaultAnswers
      : undefined;
  if (value.defaultAnswers !== undefined && (!defaultAnswers || defaultAnswers.length > 64)) {
    return null;
  }
  for (const field of ["multiSelect", "isOther", "allowEmpty"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      return null;
    }
  }
  const resource =
    value.resource === undefined ? undefined : readQuestionResourceInput(value.resource);
  if (value.resource !== undefined && (!resource || value.presentation !== "form")) {
    return null;
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
    ...(resource ? { resource } : {}),
    ...(value.presentation === "form" ? { presentation: "form" as const } : {}),
    ...(value.allowEmpty === true ? { allowEmpty: true } : {}),
    ...(value.answerFormat === "lines" ? { answerFormat: "lines" as const } : {}),
    ...(defaultAnswers ? { defaultAnswers } : {}),
    ...(url ? { url } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(typeof value.isOther === "boolean" ? { isOther: value.isOther } : {}),
    ...secretStoreFields,
  };
}
