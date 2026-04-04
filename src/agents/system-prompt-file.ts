import fs from "node:fs";
import { logWarn } from "../logger.js";

/**
 * Read the contents of a systemPromptFile config value.
 * Returns the trimmed file contents, or undefined if not configured / unreadable.
 * The file is read per session, not cached at startup — changes take effect on the next session.
 */
export function readSystemPromptFile(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch (err: unknown) {
    logWarn(`systemPromptFile: could not read "${filePath}": ${String(err)}`);
    return undefined;
  }
}
