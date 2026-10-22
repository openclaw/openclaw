// Shared web_fetch test helpers keep headers lightweight so
// unit tests avoid loading bundled provider/runtime artifacts.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function makeFetchHeaders(map: Record<string, string>): {
  get: (key: string) => string | null;
} {
  return {
    get: (key) => map[normalizeLowercaseStringOrEmpty(key)] ?? null,
  };
}
