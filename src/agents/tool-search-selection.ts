import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";
import type { CatalogSource, ToolSearchConfig } from "./tool-search-types.js";

export type ToolSearchSelection = Pick<ToolSearchConfig, "include" | "exclude">;

/** Presentation filtering only; callers supply the already-authorized tool inventory. */
export function createToolSearchSelectionMatcher(selection: ToolSearchSelection = {}) {
  const compile = (selectors: NonNullable<ToolSearchSelection["include"]>) =>
    selectors.map((selector) => ({
      source: selector.source,
      name:
        selector.name === undefined
          ? undefined
          : compileGlobPatterns({ raw: [selector.name], normalize: normalizeToolPolicyName }),
    }));
  const include = selection.include === undefined ? undefined : compile(selection.include);
  const exclude = compile(selection.exclude ?? []);
  return (tool: { source: CatalogSource; name: string }): boolean => {
    const name = normalizeToolPolicyName(tool.name);
    const matches = (selector: ReturnType<typeof compile>[number]) =>
      (selector.source === undefined || selector.source === tool.source) &&
      (selector.name === undefined || matchesAnyGlobPattern(name, selector.name));
    return (include === undefined || include.some(matches)) && !exclude.some(matches);
  };
}
