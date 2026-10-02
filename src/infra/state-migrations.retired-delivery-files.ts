import fs from "node:fs";
import path from "node:path";
import { isMissingPathError } from "./errno.js";
import { resolveLegacyMigrationSourcePath } from "./state-migrations.source-path.js";

export function listRetiredDeliveryQueueFiles(stateDir: string): string[] {
  return ["delivery-queue", "session-delivery-queue"].flatMap((name) =>
    [path.join(stateDir, name), path.join(stateDir, name, "failed")].flatMap((directory) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }
        throw error;
      }
      return entries
        .filter((entry) => {
          const source = resolveLegacyMigrationSourcePath(entry.name);
          return (
            !entry.isDirectory() && (source.endsWith(".json") || source.endsWith(".delivered"))
          );
        })
        .map((entry) => path.join(directory, entry.name));
    }),
  );
}
