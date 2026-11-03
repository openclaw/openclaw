import { githubTextReferenceSnapshot } from "../../../extensions/github-repositories/browser/text-reference-api.ts";
import type { MarkdownRenderOptions } from "../components/markdown-render-options.ts";
import {
  prepareMarkdownTextReferenceSnapshot,
  prepareMarkdownTextReferences,
} from "../components/markdown-text-references.ts";

/** Rendering fixtures use the registered provider's immutable explicit-reference resolver. */
export function githubReferenceOptions(options: MarkdownRenderOptions = {}): MarkdownRenderOptions {
  return {
    ...options,
    textReferences: prepareMarkdownTextReferences([
      prepareMarkdownTextReferenceSnapshot(githubTextReferenceSnapshot()),
      ...(options.textReferences?.snapshots ?? []),
    ]),
  };
}
