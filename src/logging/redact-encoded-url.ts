import type { RedactMatch, ResolvedRedactPattern } from "./redact-pattern-runtime.js";

// Encoded delimiters stay in the input so replacement offsets refer to the
// original log text. Each value ends at the next encoded query separator.
const ENCODED_URL_QUERY_PAIR_RE = new RegExp(
  String.raw`(%3F|%26|[?&])((?:(?!%3D|%26)[A-Za-z0-9_.%~-]){1,128})%3D((?:(?!%26)[^&\s"'<>])*)`,
  "giu",
);

export function createEncodedUrlQueryAssignmentPattern(
  isSensitiveKey: (key: string) => boolean,
  maximumDepth: number,
): ResolvedRedactPattern {
  return {
    source: "encoded URL query assignments",
    *exec(input) {
      if (!/%3d/iu.test(input)) {
        return;
      }
      function* visit(text: string, baseOffset: number, depth: number): Iterable<RedactMatch> {
        const pairs = new RegExp(ENCODED_URL_QUERY_PAIR_RE.source, ENCODED_URL_QUERY_PAIR_RE.flags);
        for (let match = pairs.exec(text); match; match = pairs.exec(text)) {
          const prefix = match[1] ?? "";
          const name = match[2] ?? "";
          const value = match[3] ?? "";
          const offset = baseOffset + match.index + prefix.length + name.length + 3;
          if (!value) {
            continue;
          }
          if (!isSensitiveKey(name)) {
            if (depth < maximumDepth && /%3f/iu.test(value)) {
              yield* visit(value, offset, depth + 1);
            }
            continue;
          }
          yield {
            match: value,
            groups: [],
            input,
            offset,
            replacement: "***",
          };
        }
      }
      yield* visit(input, 0, 0);
    },
  };
}
