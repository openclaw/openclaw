import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import type { QuestionRequestParams } from "../../packages/gateway-protocol/src/index.js";
import {
  isQuestionThumbnail,
  readQuestionResourceInput,
  readQuestionResourcePreview,
} from "../../packages/gateway-protocol/src/question-media.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { SECRET_STORE_ALLOWED_HOSTS_MAX } from "../secrets/store/secret-store-validation-error.js";

/** Shape rules after protocol validation; callers retain admission policy and error types. */
export function questionShapeError(
  questions: QuestionRequestParams["questions"],
  options: { allowPlainSecretQuestions: boolean; validateUrls: boolean },
): string | undefined {
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.questionId)) {
      return `duplicate question id '${question.questionId}'`;
    }
    ids.add(question.questionId);
    if (options.validateUrls && question.url !== undefined) {
      const url = URL.parse(question.url);
      if (!url || !hasHttpUrlPrefix(question.url) || url.username || url.password) {
        return `question '${question.questionId}' requires an absolute HTTP(S) URL without credentials`;
      }
    }
    if (question.answerFormat === "lines" && (!question.multiSelect || !question.isOther)) {
      return `question '${question.questionId}' requires multi-select custom input for line entries`;
    }
    if (question.presentation !== "form" && question.options.length === 1) {
      return `question '${question.questionId}' must have either no options or 2 to 4 options`;
    }
    if (question.presentation !== "form" && question.options.length > 4) {
      return `question '${question.questionId}' supports at most four standard options`;
    }
    if (
      question.resource &&
      (!readQuestionResourceInput(question.resource) || question.presentation !== "form")
    ) {
      return `question '${question.questionId}' requires form presentation for resource input`;
    }
    if (question.resource?.userOptions && !question.resource.viewId) {
      return `question '${question.questionId}' has unbound resource uploads`;
    }
    const binding = question.secretStore;
    if (question.isSecret && !binding && !options.allowPlainSecretQuestions) {
      return `question '${question.questionId}': secret questions are not supported yet`;
    }
    if (binding) {
      if (!question.isSecret) {
        return `question '${question.questionId}': secret store binding requires a secret question`;
      }
      if (questions.length !== 1 || question.options.length !== 0 || question.multiSelect) {
        return `question '${question.questionId}': secret store requests require one free-text, single-select question`;
      }
      if (!ENV_SECRET_REF_ID_RE.test(binding.name)) {
        return `question '${question.questionId}': invalid secret store entry name`;
      }
      if (binding.kind !== "secret") {
        return `question '${question.questionId}': masked requests require kind "secret"; set environment values in Settings or the CLI`;
      }
      if ((binding.allowedHosts?.length ?? 0) > SECRET_STORE_ALLOWED_HOSTS_MAX) {
        return `question '${question.questionId}': secret store allowed hosts exceed the limit`;
      }
    }
    const optionLabels = new Set<string>();
    const optionValues = new Set<string>();
    for (const option of question.options) {
      if (
        option.preview &&
        (!question.resource?.viewId || !readQuestionResourcePreview(option.preview))
      ) {
        return `question '${question.questionId}' has an unbound or invalid resource preview`;
      }
      if (option.thumbnail !== undefined && !isQuestionThumbnail(option.thumbnail)) {
        return `question '${question.questionId}' has an invalid thumbnail`;
      }
      const value = option.value ?? option.label;
      if (optionValues.has(value)) {
        return `question '${question.questionId}' has duplicate option values`;
      }
      optionValues.add(value);
      const normalizedLabel = option.label.trim().toLowerCase();
      if (optionLabels.has(normalizedLabel)) {
        return `question '${question.questionId}' has duplicate option label '${option.label}'`;
      }
      optionLabels.add(normalizedLabel);
    }
  }
  return undefined;
}
