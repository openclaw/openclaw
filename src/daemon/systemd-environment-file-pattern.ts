/** Expand systemd POSIX EnvironmentFile patterns without normalizing literal path bytes. */
import fs from "node:fs/promises";
import { Minimatch } from "minimatch";
import { hasErrnoCode } from "../infra/errno.js";

export async function expandSystemdEnvironmentFilePattern(pattern: string): Promise<string[]> {
  const [parts] = new Minimatch(pattern, {
    nobrace: true,
    noext: true,
    noglobstar: true,
    platform: "linux",
    optimizationLevel: 0,
  }).set;
  if (!parts) {
    return [];
  }
  if (parts.every((part) => typeof part === "string")) {
    return [parts.join("/")];
  }
  // Node's fs.glob treats backslashes as separators. Match the parsed POSIX
  // components instead, preserving escaped literals and symlink-sensitive parent segments.
  let pathnames = ["/"];
  for (const part of parts.slice(1)) {
    const matches: string[] = [];
    for (const parent of pathnames) {
      const prefix = parent.endsWith("/") ? parent : `${parent}/`;
      if (typeof part === "string") {
        matches.push(`${prefix}${part}`);
        continue;
      }
      try {
        for (const entry of await fs.readdir(parent)) {
          if (part instanceof RegExp && part.test(entry)) {
            matches.push(`${prefix}${entry}`);
          }
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
          throw error;
        }
      }
    }
    pathnames = matches;
  }
  const existing: string[] = [];
  for (const pathname of pathnames) {
    try {
      await fs.lstat(pathname);
      existing.push(pathname);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
    }
  }
  return existing;
}
