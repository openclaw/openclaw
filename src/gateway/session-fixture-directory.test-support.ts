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
      // Dirents keep recursive enumeration from following links outside the fixture.
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      remaining = JSON.stringify(
        entries
          .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
          .toSorted(),
      );
    } catch (error) {
      remaining = `unavailable (${String(error)})`;
    }
    throw new Error(
      `Failed to remove session fixture ${JSON.stringify(dir)}: ${String(cause)}; remaining entries: ${remaining}`,
      { cause },
    );
  }
}
