// Stream wrapper that selects the stream-safe strict-on-flush reasoning-tag
// level for models whose replies can leak inline reasoning markup into visible
// content (e.g. vLLM mimo-parser endpoints). Incremental streaming is preserved;
// only an unclosed inline reasoning block is dropped at flush. The caller
// supplies the model predicate so provider selection stays outside the SDK seam.
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "../../../agents/runtime/index.js";

export function createStrictReasoningTagsWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  shouldMarkStrictOnFlush: (model: Parameters<StreamFn>[0]) => boolean;
}): StreamFn | undefined {
  if (!params.baseStreamFn) {
    return undefined;
  }
  const underlying = params.baseStreamFn;
  return (model, context, options) => {
    if (!params.shouldMarkStrictOnFlush(model)) {
      return underlying(model, context, options);
    }
    // Mark a fresh spread copy so the caller's options object stays untouched.
    const strictOptions = { ...options };
    reasoningTagTextPolicy.markStrictOnFlush(strictOptions);
    return underlying(model, context, strictOptions);
  };
}
