import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";

export function snapshotUpdateFixtureTree(root: string, readStat = fs.statSync) {
  return listDirectoryTreeStrictSync(root)
    .map((walkEntry) => walkEntry.relativePath)
    .map(String)
    .toSorted()
    .map((name) => {
      const filename = path.join(root, name);
      const stat = readStat(filename);
      return [
        name,
        stat.ino,
        stat.mtimeMs,
        stat.mode,
        stat.isFile() ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex") : null,
      ];
    });
}
