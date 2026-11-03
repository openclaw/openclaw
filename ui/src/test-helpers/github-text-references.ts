import { githubTextReferenceSnapshot } from "../../../extensions/github-repositories/browser/text-reference-api.ts";
import type { MarkdownRenderOptions } from "../components/markdown-render-options.ts";

/** Rendering fixtures use the registered provider's immutable explicit-reference resolver. */
export function githubReferenceOptions(options: MarkdownRenderOptions = {}): MarkdownRenderOptions {
  return {
    ...options,
    textReferences: [githubTextReferenceSnapshot(), ...(options.textReferences ?? [])],
  };
}
