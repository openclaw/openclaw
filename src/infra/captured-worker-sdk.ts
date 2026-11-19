import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Capture = { root: string; preload: () => string };
const captures = new Set<Capture>();

export function bindCapturedWorkerSdk(
  directory: string,
  host: string,
  getAliases: () => Readonly<Record<string, string>>,
): () => void {
  const root = pathToFileURL(fs.realpathSync.native(directory) + path.sep).href;
  const hostRoot = fs.realpathSync.native(host);
  let cached: string | undefined;
  const capture = {
    root,
    preload() {
      if (!cached) {
        const aliases: Array<[string, string]> = [];
        for (const [name, target] of Object.entries(getAliases())) {
          if (!/^(?:openclaw|@openclaw)\/plugin-sdk\//u.test(name) || !path.isAbsolute(target)) {
            continue;
          }
          const relative = path.relative(hostRoot, target);
          if (relative && relative !== ".." && !relative.startsWith(".." + path.sep) &&
              !path.isAbsolute(relative) && /\.[cm]?[jt]s$/iu.test(relative)) {
            aliases.push([name, relative]);
          }
        }
        const url = pathToFileURL(path.join(hostRoot, "dist", "plugin-sdk-worker-preload.js"));
        url.searchParams.set("root", root);
        url.searchParams.set("aliases", JSON.stringify(aliases));
        cached = url.href;
      }
      return cached;
    },
  };
  captures.add(capture);
  return () => {
    captures.delete(capture);
  };
}

export function capturedWorkerSdkPreload(entry: URL): string | undefined {
  if (!captures.size || entry.protocol !== "file:") {
    return undefined;
  }
  let physical: string;
  try {
    physical = pathToFileURL(fs.realpathSync.native(fileURLToPath(entry))).href;
  } catch {
    // Ordinary worker creation owns the missing-entry error and its timing.
    return undefined;
  }
  let match: Capture | undefined;
  for (const capture of captures) {
    if (physical.startsWith(capture.root)) {
      if (match) {
        throw new Error("Ambiguous captured plugin worker SDK owner");
      }
      match = capture;
    }
  }
  return match?.preload();
}
