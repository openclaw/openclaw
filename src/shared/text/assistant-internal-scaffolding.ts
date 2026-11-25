import {
  stripRelevantMemoriesTags,
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  plainToolCallTransform,
  stripInvisibleAssistantText,
} from "./assistant-text-transforms.js";
import { orderInternalScaffoldingStages } from "./internal-scaffolding-stages.js";
import { stripModelSpecialTokens } from "./model-special-token-transform.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";
import { stripLeadingEmptyLines } from "./strip-leading-empty-lines.js";
import { stripToolCallXmlTags } from "./tool-call-xml-transform.js";

const transforms = orderInternalScaffoldingStages<(text: string) => string>({
  reasoning: (text) =>
    stripReasoningTagsFromText(text, {
      mode: "preserve",
      scope: "all",
      trim: "none",
      recoverUnclosed: true,
    }),
  modelTokens: stripModelSpecialTokens,
  memories: stripRelevantMemoriesTags,
  xml: stripToolCallXmlTags,
  trace: stripAssistantInternalTraceLines,
  legacy: stripLegacyBracketToolCallBlocks,
  plain: plainToolCallTransform,
  leading: stripLeadingEmptyLines,
  invisible: stripInvisibleAssistantText,
});

export function stripAssistantInternalScaffolding(text: string): string {
  let transformed = text;
  for (const transform of transforms) {
    transformed = transform(transformed);
  }
  return transformed;
}
