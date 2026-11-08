import fs from "node:fs/promises";
import path from "node:path";

export async function resolveMediaFilePath(file: string): Promise<string> {
  if (process.platform === "win32" || !file.split("/").includes("..")) {
    return path.resolve(file);
  }
  const name = path.basename(file);
  if (file.endsWith("/") || name === "." || name === "..") {
    throw new Error(`Expected a regular media file: ${file}`);
  }
  // Resolve symlinks before parent segments, but leave the final link for the media root check.
  return path.join(await fs.realpath(path.dirname(file)), name);
}
