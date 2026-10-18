import { hasNodeErrorCode } from "./path-guards.js";

export function ignoreMissingUpdateCandidateFile(error: unknown): undefined {
  if (hasNodeErrorCode(error, "ENOENT")) {
    return undefined;
  }
  throw error;
}
