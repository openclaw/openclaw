import fs from "node:fs";
import { logVerbose } from "../globals.js";

/**
 * Read the contents of a systemPromptFile config value.
 * Returns the trimmed file contents, or undefined if not configured / unreadable.
 */
export function readSystemPromptFile(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch (err: unknown) {
    logVerbose(`systemPromptFile: could not read "${filePath}": ${String(err)}`);
    return undefined;
  }
}
