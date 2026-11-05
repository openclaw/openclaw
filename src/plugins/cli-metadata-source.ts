import fs from "node:fs";
import path from "node:path";

export function resolveCliMetadataEntrySource(rootDir: string, source: string): string | null {
  for (const directory of new Set([rootDir, path.dirname(source)])) {
    for (const extension of [".ts", ".js", ".mjs", ".cjs"]) {
      const candidate = path.join(directory, `cli-metadata${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
