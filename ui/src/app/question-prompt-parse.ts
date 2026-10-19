import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
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
  const options = value.options.flatMap((option) => {
    const label = readNonEmptyString(option.label);
    if (!label) {
      return [];
    }
    if (option.thumbnail !== undefined && !isQuestionThumbnail(option.thumbnail)) {
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
        ...option,
        label,
        ...(preview ? { preview } : {}),
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
    const parsed = URL.parse(url);
    if (!parsed || parsed.username || parsed.password) {
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
    ...value,
    questionId,
    header: clampedHeader,
    question,
    options,
    ...(resource ? { resource } : {}),
    ...(url ? { url } : {}),
    ...secretStoreFields,
  };
}
