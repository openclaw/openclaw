import { select } from "@clack/prompts";
import { stylePromptHint, stylePromptMessage } from "./prompt-style.js";

export function selectStyled<T>(params: Parameters<typeof select<T>>[0]) {
  return select({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
}
