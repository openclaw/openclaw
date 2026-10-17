import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

/** Read author-owned metadata without silently replacing malformed input bytes. */
export function readPluginAuthoringJson(
  filePath: string,
  options: { json5?: boolean } = {},
): Record<string, unknown> {
  const bytes = fs.readFileSync(filePath);
  if (!isUtf8(bytes)) {
    throw new Error(`JSON file must be valid UTF-8: ${filePath}`);
  }
  try {
    const raw = bytes.toString("utf8");
    // SAFETY: Preserve the JSON-object authoring contract; values stay unknown for consumers to narrow.
    return (options.json5 ? parseJsonWithJson5Fallback(raw) : JSON.parse(raw)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new Error(`Malformed JSON in ${filePath}`, { cause: err });
  }
}
