import type { TranslationMap } from "./types.ts";

/** Install every leaf while retaining shared namespace objects and sibling copy. */
export function mergeCatalog(target: TranslationMap, source: TranslationMap): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      target[key] = value;
    } else {
      const nested = target[key];
      mergeCatalog((target[key] = typeof nested === "object" ? nested : {}), value);
    }
  }
}
