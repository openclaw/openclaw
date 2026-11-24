import { z } from "zod";
import { validatePluginRecommendedPrompts } from "../../packages/plugin-package-contract/src/recommended-prompts.js";

/** Agent and Template metadata share the plugin prompt normalization and limits. */
export const RecommendedPromptsSchema = z.array(z.string()).transform((prompts, ctx) => {
  const result = validatePluginRecommendedPrompts(prompts);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  }
  return result.recommendedPrompts ?? [];
});
