import fs from "node:fs";
import { isMissingPathError } from "./errno.js";

/** Only definite absence, including a non-directory ancestor, permits an absent verdict. */
export function pathMayExistSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}
