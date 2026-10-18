import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function snapshotUpdateFixtureTree(root: string, readStat = fs.statSync) {
  return fs
    .readdirSync(root, { recursive: true })
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
