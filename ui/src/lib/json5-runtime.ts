// Lazy JSON5 boundary: strict JSON parses without the library, so json5 stays
// out of the startup graph and loads only for config text that needs it.
type Json5Module = { parse: (text: string) => unknown };

let json5: Json5Module | null = null;
let json5Loading: Promise<Json5Module> | null = null;

export function warmJson5(): Promise<Json5Module> {
  json5Loading ??= import("json5").then((mod) => {
    json5 = mod.default;
    return json5;
  });
  return json5Loading;
}

/**
 * Strict-JSON fast path with a JSON5 fallback once the module is warmed.
 * Callers on the config surfaces warm the module before raw drafts can exist;
 * if a JSON5-only text races the warm-up, this throws like a parse failure and
 * the caller's existing invalid-draft handling applies until retry.
 */
export function parseJson5Text(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (jsonError) {
    if (json5) {
      return json5.parse(raw);
    }
    void warmJson5();
    throw jsonError;
  }
}
