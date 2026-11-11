import path from "node:path";
import { root as openRoot, type Root } from "@openclaw/fs-safe/root";
import { SCRATCH_TTL_MS } from "../shared/scratch-expiry.js";
import { hasErrnoCode } from "./errno.js";

const MAX_SCAN_ENTRIES = 2_000_000;
const MAX_TOP_LEVEL_ENTRIES = 256;
const MAX_TOP_LEVEL_NAMES = 4096;
const MAX_DEPTH = 64;
const DELETE_BATCH_SIZE = 128;
const DELETE_BATCH_DELAY_MS = 100;

export type ScratchCleanupTarget = {
  root: string;
  kind: "checkout" | "coverage";
  isLive: () => boolean;
  prepare?: () => Promise<void>;
};

export type ScratchCleanupResult = {
  entriesRemoved: number;
  bytesRemoved: number;
  filesRemoved: number;
  skippedLive: number;
  scanned: number;
  deferred: number;
  errors: string[];
};

export type ScratchCleanupCursor = {
  root?: string;
  kind?: ScratchCleanupTarget["kind"];
  filesystem?: Root;
  entries?: ReturnType<Root["entries"]>;
  pending?: string;
};

/** Release the one directory handle before shutdown or removal of its checkout. */
export async function closeScratchCleanupCursor(cursor: ScratchCleanupCursor, root?: string) {
  if (root !== undefined && cursor.root !== path.resolve(root)) {
    return;
  }
  const entries = cursor.entries;
  delete cursor.entries;
  delete cursor.filesystem;
  delete cursor.pending;
  delete cursor.root;
  delete cursor.kind;
  await entries?.return?.();
}

class ScratchBudgetExhausted extends Error {
  constructor(readonly retry: boolean) {
    super("scratch scan budget exhausted; entry retained");
  }
}

/** One bounded pass; the maintenance owner supplies current custody and pacing. */
export async function cleanScratch(params: {
  targets: readonly ScratchCleanupTarget[];
  now: number;
  assertCurrent: () => void;
  pause: (milliseconds: number) => Promise<void>;
  cursor: ScratchCleanupCursor;
  onProgress?: (result: ScratchCleanupResult) => void;
}): Promise<ScratchCleanupResult> {
  const result: ScratchCleanupResult = {
    entriesRemoved: 0,
    bytesRemoved: 0,
    filesRemoved: 0,
    skippedLive: 0,
    scanned: 0,
    deferred: 0,
    errors: [],
  };
  params.onProgress?.(result);
  const cursor = params.cursor;
  if (
    !params.targets.some((target) => target.root === cursor.root && target.kind === cursor.kind)
  ) {
    await closeScratchCleanupCursor(cursor);
  }
  let inspected = 0;
  let names = 0;
  let removalVisits = 0;
  const cutoff = params.now - SCRATCH_TTL_MS;
  const recordError = (location: string, error: unknown) => {
    result.deferred++;
    if (result.errors.length < 16) {
      result.errors.push(`${location}: ${String(error)}`);
    }
  };
  const first = Math.max(
    0,
    params.targets.findIndex(
      (target) => target.root === cursor.root && target.kind === cursor.kind,
    ),
  );
  for (let index = 0; index < params.targets.length; index++) {
    const targetIndex = (first + index) % params.targets.length;
    const target = params.targets[targetIndex]!;
    let live = false;
    const assertIdle = () => {
      params.assertCurrent();
      live = target.isLive();
      if (live) {
        throw new Error("scratch checkout acquired live or queued work");
      }
    };
    try {
      await target.prepare?.();
      assertIdle();
      if (!cursor.filesystem) {
        cursor.root = target.root;
        cursor.kind = target.kind;
        cursor.filesystem = await openRoot(target.root, {
          symlinks: "reject",
          mutationSymlinks: "reject",
        });
        if (cursor.filesystem.rootReal !== path.resolve(target.root)) {
          throw new Error("scratch root uses a symlink; entry retained");
        }
        cursor.entries = cursor.filesystem.entries(
          target.kind === "checkout" ? ".openclaw/tmp" : ".",
          { order: "filesystem", symlinks: "reject" },
        );
      }
      const root = cursor.filesystem;
      const walk = async (
        relativePath: string,
        stat: Awaited<ReturnType<Root["stat"]>>,
        depth: number,
        remove: boolean,
        entryCount: { value: number },
      ): Promise<number> => {
        if (depth > MAX_DEPTH || entryCount.value >= MAX_SCAN_ENTRIES) {
          throw new ScratchBudgetExhausted(false);
        }
        if ((remove ? removalVisits : result.scanned) >= MAX_SCAN_ENTRIES) {
          throw new ScratchBudgetExhausted(true);
        }
        entryCount.value++;
        if (remove) {
          removalVisits++;
        } else {
          result.scanned++;
        }
        params.assertCurrent();
        if (stat.isSymbolicLink || (!stat.isDirectory && !stat.isFile)) {
          throw new Error("scratch contains a symlink or special file; entry retained");
        }
        let newest = stat.isFile ? stat.mtimeMs : -Infinity;
        if (stat.isDirectory) {
          for await (const child of root.entries(relativePath, {
            order: "filesystem",
            symlinks: "reject",
          })) {
            newest = Math.max(
              newest,
              await walk(path.join(relativePath, child.name), child, depth + 1, remove, entryCount),
            );
            if (!remove && newest >= cutoff) {
              return newest;
            }
          }
        }
        if (remove) {
          if (result.filesRemoved > 0 && result.filesRemoved % DELETE_BATCH_SIZE === 0) {
            await params.pause(DELETE_BATCH_DELAY_MS);
            await target.prepare?.();
          }
          await root.remove(relativePath, { assertBeforeMutation: assertIdle });
          result.filesRemoved++;
          result.bytesRemoved += stat.isFile ? stat.size : 0;
        }
        return newest;
      };
      while (true) {
        if (
          names >= MAX_TOP_LEVEL_NAMES ||
          inspected >= MAX_TOP_LEVEL_ENTRIES ||
          result.scanned >= MAX_SCAN_ENTRIES ||
          removalVisits >= MAX_SCAN_ENTRIES
        ) {
          result.deferred++;
          return result;
        }
        let relativePath = cursor.pending;
        let stat: Awaited<ReturnType<Root["stat"]>>;
        if (relativePath !== undefined) {
          // A yielded candidate may have been rewritten between maintenance passes.
          stat = await root.stat(relativePath);
        } else {
          const next = await cursor.entries!.next();
          if (next.done) {
            break;
          }
          names++;
          if (
            target.kind === "coverage" &&
            (!next.value.isDirectory || !/^node-coverage-.+/u.test(next.value.name))
          ) {
            result.scanned++;
            continue;
          }
          relativePath = path.join(
            target.kind === "checkout" ? ".openclaw/tmp" : ".",
            next.value.name,
          );
          stat = next.value;
          cursor.pending = relativePath;
        }
        inspected++;
        assertIdle();
        try {
          const newest = await walk(relativePath, stat, 0, false, { value: 0 });
          if ((newest === -Infinity ? stat.mtimeMs : newest) < cutoff) {
            await target.prepare?.();
            await walk(relativePath, await root.stat(relativePath), 0, true, { value: 0 });
            result.entriesRemoved++;
          }
        } catch (error) {
          params.assertCurrent();
          if (live) {
            throw error;
          }
          recordError(`${target.root}/${relativePath}`, error);
          if (error instanceof ScratchBudgetExhausted && error.retry) {
            return result;
          }
        }
        delete cursor.pending;
      }
    } catch (error) {
      await closeScratchCleanupCursor(cursor);
      params.assertCurrent();
      if (live) {
        result.skippedLive++;
      } else if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "not-found")) {
        recordError(target.root, error);
      }
    }
    await closeScratchCleanupCursor(cursor);
    const next = params.targets[(targetIndex + 1) % params.targets.length];
    cursor.root = next?.root;
    cursor.kind = next?.kind;
  }
  return result;
}
