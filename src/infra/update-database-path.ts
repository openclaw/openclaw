import { realpathSync } from "node:fs";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { ignoreMissingPath } from "./errno.js";

/** Match capture inventory keys, including stores created during Doctor. */
export function resolveUpdateSqlitePath(pathname: string): string {
  try {
    return realpathSync.native(pathname);
  } catch (error) {
    ignoreMissingPath(error);
    return resolvePathViaExistingAncestorSync(pathname);
  }
}
