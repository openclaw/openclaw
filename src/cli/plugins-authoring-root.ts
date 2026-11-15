import fs from "node:fs";
import { throwExpectedCliError } from "./expected-cli-error.js";

export function resolveRootPath(input = process.cwd()): string {
  try {
    return fs.realpathSync.native(input);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throwExpectedCliError(
        `Plugin root not found: ${input}. Set --root to an existing plugin project directory containing package.json, then retry.`,
      );
    }
    throw error;
  }
}
