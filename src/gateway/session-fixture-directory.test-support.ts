import type { RmOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Remove an already-released fixture, preserving evidence of a late writer. */
export async function removeSessionFixtureDirectory(
  dir: string,
  options?: Pick<RmOptions, "maxRetries" | "retryDelay">,
): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, ...options });
  } catch (cause) {
    let remaining: string;
    try {
      // Recursive readdir can follow directory symlinks, so own the descent.
      const entries: string[] = [];
      const directories = [dir];
      for (const directory of directories) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          entries.push(path.relative(dir, entryPath));
          if (entry.isDirectory()) {
            directories.push(entryPath);
          }
        }
      }
      remaining = JSON.stringify(entries.toSorted());
    } catch (error) {
      remaining = `unavailable (${String(error)})`;
    }
    throw new Error(
      `Failed to remove session fixture ${JSON.stringify(dir)}: ${String(cause)}; remaining entries: ${remaining}`,
      { cause },
    );
  }
}
