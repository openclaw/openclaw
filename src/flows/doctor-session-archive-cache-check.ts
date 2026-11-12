import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { resolveExistingPreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/session-archive-read-cache";
// Include interrupted writes from the retired materializer, but no other names.
const CACHE_FILE =
  /^[a-f0-9]{32}-\d+-\d+\.jsonl(?:\.\d+\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp)?$/;

function inspectCache() {
  const tmp = resolveExistingPreferredOpenClawTmpDir();
  if (!tmp) {
    return undefined;
  }
  const directory = path.join(tmp, "session-archive-read-cache");
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) {
    return { directory, stat, bytes: 0, files: [], remaining: 0 };
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      `Refusing archive read-cache cleanup at ${directory}: not an owned, non-symlink directory.`,
    );
  }
  const entries = fs.readdirSync(directory);
  let bytes = 0;
  const files: string[] = [];
  for (const name of entries) {
    const entry = fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false });
    if (entry?.isFile()) {
      bytes += entry.size;
      if (CACHE_FILE.test(name)) {
        files.push(name);
      }
    }
  }
  return { directory, stat, bytes, files, remaining: entries.length };
}

export const sessionArchiveCacheCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  source: "doctor",
  description: "Plaintext read-cache files from older versions have been removed.",
  async detect() {
    try {
      const cache = inspectCache();
      return cache?.stat
        ? [
            {
              checkId: CHECK_ID,
              severity: "warning",
              path: cache.directory,
              message: `Legacy archive read-cache remains: ${cache.bytes} bytes in ${cache.remaining} entries at ${cache.directory}.`,
              fixHint:
                "Run `openclaw doctor --fix` to remove recognized cache files; unrelated entries are preserved.",
            } satisfies HealthFinding,
          ]
        : [];
    } catch (error) {
      return [{ checkId: CHECK_ID, severity: "warning", message: String(error) }];
    }
  },
  async repair(ctx) {
    const changes: string[] = [];
    const warnings: string[] = [];
    if (ctx.dryRun) {
      return { changes };
    }
    try {
      const cache = inspectCache();
      if (!cache?.stat) {
        return { changes };
      }
      const assertCurrent = () => {
        const current = fs.lstatSync(cache.directory);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== cache.stat.dev ||
          current.ino !== cache.stat.ino ||
          current.uid !== cache.stat.uid
        ) {
          throw new Error("Archive read-cache directory changed during cleanup.");
        }
      };
      const directory = await root(cache.directory, {
        mutationSymlinks: "reject",
        assertBeforeMutation: assertCurrent,
      });
      let removed = 0;
      for (const file of cache.files) {
        try {
          await directory.remove(file, {
            assertBeforeMutation: () => {
              assertCurrent();
              if (!fs.lstatSync(path.join(cache.directory, file)).isFile()) {
                throw new Error("Archive read-cache entry is no longer a regular file.");
              }
            },
          });
          removed++;
        } catch (error) {
          warnings.push(`Could not remove ${file}: ${String(error)}`);
        }
      }
      if (removed > 0) {
        changes.push(
          `Removed ${removed} legacy archive read-cache file(s) from ${cache.directory}.`,
        );
      }
      assertCurrent();
      if (fs.readdirSync(cache.directory).length === 0) {
        fs.rmdirSync(cache.directory);
        changes.push(`Removed empty archive read-cache directory ${cache.directory}.`);
      }
    } catch (error) {
      warnings.push(String(error));
    }
    return { changes, warnings };
  },
};
