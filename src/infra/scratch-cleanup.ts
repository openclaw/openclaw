import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { root as openRoot, type Root } from "@openclaw/fs-safe/root";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SCRATCH_TTL_MS } from "../shared/scratch-expiry.js";
import { hasErrnoCode } from "./errno.js";
import type { FsSafeCopyReply } from "./fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  SCRATCH_MAX_ENTRIES,
  SCRATCH_DELETE_BATCH_SIZE,
  type ScratchTreeRequest,
  type ScratchTreeResult,
} from "./scratch-cleanup-tree.js";
import { createWorkerMutationAuthority } from "./worker-mutation-authority.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const MAX_TOP_LEVEL_ENTRIES = 256;
const MAX_TOP_LEVEL_NAMES = 4096;
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
  signal?: AbortSignal;
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
        remove: boolean,
      ): Promise<number> => {
        if (!stat.isDirectory) {
          params.assertCurrent();
          if (!stat.isSymbolicLink && !stat.isFile) {
            throw new Error("scratch contains a special file; entry retained");
          }
          if (remove) {
            removalVisits++;
            if (result.filesRemoved > 0 && result.filesRemoved % SCRATCH_DELETE_BATCH_SIZE === 0) {
              await params.pause(DELETE_BATCH_DELAY_MS);
              await target.prepare?.();
            }
            await root.remove(relativePath, { assertBeforeMutation: assertIdle });
            result.filesRemoved++;
            result.bytesRemoved += stat.isFile ? stat.size : 0;
          } else {
            result.scanned++;
          }
          return stat.mtimeMs;
        }
        const runtime = resolveGlobalSingleton<{
          pool?: WorkerTaskPool<ScratchTreeRequest, FsSafeCopyReply>;
        }>(
          Symbol.for("openclaw.scratchCleanupTrees"),
          () => ({}),
          async (owned) => {
            const pool = owned.pool;
            owned.pool = undefined;
            await pool?.close();
          },
        );
        const pool = (runtime.pool ??= new WorkerTaskPool({
          workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
          maxWorkers: 1,
          idleTimeoutMs: 30_000,
        }));
        let visits = 0;
        let files = 0;
        let bytes = 0;
        const progress = (next: ScratchTreeResult) => {
          if (remove) {
            removalVisits += next.visited - visits;
            result.filesRemoved += next.filesRemoved - files;
            result.bytesRemoved += next.bytesRemoved - bytes;
          } else {
            result.scanned += next.visited - visits;
          }
          visits = next.visited;
          files = next.filesRemoved;
          bytes = next.bytesRemoved;
        };
        let checkpoint: Promise<void> | undefined;
        let refusal: { error: unknown } | undefined;
        const authority = createWorkerMutationAuthority(() => {
          if (refusal) {
            throw refusal.error;
          }
          params.assertCurrent();
        }, params.signal);
        let next: FsSafeCopyReply;
        try {
          next = await pool.run(
            {
              type: "scratch",
              decision: authority.buffer,
              root: target.root,
              relativePath,
              identity: { dev: stat.dev, ino: stat.ino, exactIdentity: stat.exactIdentity },
              cutoff,
              remaining: SCRATCH_MAX_ENTRIES - (remove ? removalVisits : result.scanned),
              remove,
              removedBefore: result.filesRemoved,
            },
            {
              signal: params.signal,
              inputBytes: Buffer.byteLength(target.root) + Buffer.byteLength(relativePath),
              onNotification: (value) => {
                // SAFETY: The private filesystem worker sends only this task's progress receipt.
                progress(value as ScratchTreeResult);
                checkpoint = (async () => {
                  try {
                    await params.pause(DELETE_BATCH_DELAY_MS);
                  } catch (error) {
                    refusal = { error };
                  }
                  authority.onNotification();
                })();
              },
            },
          );
        } finally {
          await checkpoint;
          authority.dispose();
        }
        authority.throwIfRefused();
        params.assertCurrent();
        if (next.type !== "scratch") {
          throw new Error(next.type === "failed" ? next.message : "Invalid scratch worker receipt");
        }
        progress(next);
        if (next.error) {
          if (next.retry !== undefined) {
            throw new ScratchBudgetExhausted(next.retry);
          }
          throw new Error(next.error);
        }
        return next.newest;
      };
      while (true) {
        if (
          names >= MAX_TOP_LEVEL_NAMES ||
          inspected >= MAX_TOP_LEVEL_ENTRIES ||
          result.scanned >= SCRATCH_MAX_ENTRIES ||
          removalVisits >= SCRATCH_MAX_ENTRIES
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
          const newest = await walk(relativePath, stat, false);
          if ((newest === -Infinity ? stat.mtimeMs : newest) < cutoff) {
            await target.prepare?.();
            assertIdle();
            if (stat.isDirectory) {
              const original = relativePath;
              const claimed = path.join(
                path.dirname(relativePath),
                `${target.kind === "coverage" ? "node-coverage" : ".reclaim"}-${randomUUID()}`,
              );
              // Remove the expired name from task custody before handing its tree to the worker.
              await root.move(original, claimed, {
                // The generated destination also permits fs-safe's portable rename path.
                overwrite: true,
                assertBeforeMutation: () => {
                  assertIdle();
                  const current = lstatSync(path.join(target.root, original), { bigint: true });
                  const expected = stat.exactIdentity;
                  if (
                    expected
                      ? current.dev !== expected.dev || current.ino !== expected.ino
                      : Number(current.dev) !== stat.dev || Number(current.ino) !== stat.ino
                  ) {
                    throw new Error("scratch entry identity changed; entry retained");
                  }
                },
              });
              relativePath = claimed;
              cursor.pending = claimed;
            }
            await walk(relativePath, stat, true);
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
