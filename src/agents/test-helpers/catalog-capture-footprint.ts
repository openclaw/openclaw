import fs from "node:fs";
import path from "node:path";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "../../plugins/plugin-source-capture-path.js";

/** Follow explicit native references, never incidental host SDK or dependency links. */
export function readCatalogCaptureFootprint(root: string, nativeArtifacts: readonly string[] = []) {
  const captures: Array<{ path: string; device: number; inode: number }> = [];
  const references = nativeArtifacts.map((filename) => {
    const target = fs.realpathSync(filename);
    const stat = fs.statSync(target);
    return { path: target, device: stat.dev, inode: stat.ino, bytes: stat.size };
  });
  let bytes = 0;
  let allocatedBytes = 0;
  const directories = new Set<string>();
  const files = new Set<string>();
  const pending = [root, ...references.map((reference) => path.dirname(reference.path))];
  for (const directory of pending) {
    const canonical = fs.realpathSync(directory);
    if (directories.has(canonical)) {
      continue;
    }
    directories.add(canonical);
    for (const name of fs.readdirSync(directory).toSorted()) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        pending.push(filename);
        if (name.startsWith(PLUGIN_SOURCE_CAPTURE_PREFIX)) {
          captures.push({ path: path.relative(root, filename), device: stat.dev, inode: stat.ino });
        }
      } else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (files.has(identity)) {
          continue;
        }
        files.add(identity);
        bytes += stat.size;
        allocatedBytes += stat.blocks * 512;
      }
    }
  }
  return { captures, references, bytes, allocatedBytes };
}
