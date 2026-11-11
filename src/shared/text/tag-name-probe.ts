import type { TextProjection } from "./text-projection.js";

/** Proves tag absence; the canonical transform owns attributes and Markdown after activation. */
export function createTagNameProbe(names: readonly string[]): (input: TextProjection) => boolean {
  let prefix: string | undefined;
  let active = false;
  return ({ text, delta }) => {
    if (active) {
      return true;
    }
    for (const char of delta ?? text) {
      if (char === "<") {
        prefix = "";
      } else if (prefix !== undefined) {
        // Arbitrary spacing stays in state instead of growing the retained prefix.
        if ((prefix === "" || prefix === "/") && /\s/u.test(char)) {
          continue;
        }
        if (prefix === "" && char === "/") {
          prefix = "/";
          continue;
        }
        const name = prefix.startsWith("/") ? prefix.slice(1) : prefix;
        if (names.includes(name) && /[\s/>]/u.test(char)) {
          active = true;
          return true;
        }
        prefix += char.toLowerCase();
        const partial = prefix.startsWith("/") ? prefix.slice(1) : prefix;
        if (!names.some((candidate) => candidate.startsWith(partial))) {
          prefix = undefined;
        }
      }
    }
    return false;
  };
}
