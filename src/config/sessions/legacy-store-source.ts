import fs from "node:fs";

/** A retained file-backed session store needs the legacy startup inspector. */
export function isExistingLegacySessionStore(storePath: string): boolean {
  return !storePath.endsWith(".sqlite") && fs.existsSync(storePath);
}
