import { isUtf8 } from "node:buffer";
import fs from "node:fs";

/** Read author-owned metadata without silently replacing malformed input bytes. */
export function readPluginAuthoringJson(filePath: string): Record<string, unknown> {
  const bytes = fs.readFileSync(filePath);
  if (!isUtf8(bytes)) {
    throw new Error(`JSON file must be valid UTF-8: ${filePath}`);
  }
  try {
    // SAFETY: Preserve the JSON-object authoring contract; values stay unknown for consumers to narrow.
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Malformed JSON in ${filePath}`, { cause: err });
  }
}
