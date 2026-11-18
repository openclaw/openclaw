import fs from "node:fs";

// Keep source detection independent of the legacy inspector's schema graph.
export function isExistingLegacySessionStore(storePath: string): boolean {
  return !storePath.endsWith(".sqlite") && fs.existsSync(storePath);
}
