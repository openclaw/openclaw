import fs from "node:fs";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { decodeUtf8Input } from "../infra/utf8-input.js";

/** Read author-owned metadata without silently replacing malformed input bytes. */
export function readPluginAuthoringJson(filePath: string): Record<string, unknown> {
  const { buffer } = readRegularFileSync({ filePath: fs.realpathSync(filePath) });
  const text = decodeUtf8Input(buffer, `JSON file ${filePath}`);
  try {
    // SAFETY: Preserve the JSON-object authoring contract; values stay unknown for consumers to narrow.
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Malformed JSON in ${filePath}`, { cause: err });
  }
}
