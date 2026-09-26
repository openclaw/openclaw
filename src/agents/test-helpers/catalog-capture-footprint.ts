import fs from "node:fs";
import path from "node:path";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "../../plugins/plugin-source-capture-path.js";

/** Measure only this fixture's physical tree, never linked host SDK or dependency trees. */
export function readCatalogCaptureFootprint(root: string) {
  const captures: Array<{ path: string; device: number; inode: number }> = [];
  let bytes = 0;
  let allocatedBytes = 0;
  const pending = [root];
  for (const directory of pending) {
    for (const name of fs.readdirSync(directory).toSorted()) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        pending.push(filename);
        if (name.startsWith(PLUGIN_SOURCE_CAPTURE_PREFIX)) {
          captures.push({ path: path.relative(root, filename), device: stat.dev, inode: stat.ino });
        }
      } else if (stat.isFile()) {
        bytes += stat.size;
        allocatedBytes += stat.blocks * 512;
      }
    }
  }
  return { captures, bytes, allocatedBytes };
}
