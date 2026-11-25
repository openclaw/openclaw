import fs from "node:fs";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { ExpectedCliError } from "./expected-cli-error.js";

/** Read author-owned metadata without silently replacing malformed input bytes. */
export function readPluginAuthoringJson(filePath: string, json5 = false) {
  const { buffer } = readRegularFileSync({ filePath: fs.realpathSync(filePath) });
  const text = decodeUtf8Input(buffer, `JSON file ${filePath}`);
  try {
    // SAFETY: Preserve the JSON-object authoring contract; values stay unknown for consumers to narrow.
    return (json5 ? parseJsonWithJson5Fallback : JSON.parse)(text) as Record<string, unknown>;
  } catch (err) {
    const message = `Malformed JSON in ${filePath}`;
    throw new ExpectedCliError({
      message,
      humanOutput: message,
      machineOutput: message,
      cause: err,
    });
  }
}
