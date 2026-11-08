// Prepares the jiti filesystem cache so the platform temp-root guard accepts a workspace under it.
import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";

/**
 * Create the jiti cache directories with a PRIVATE mode before jiti first writes to them.
 *
 * jiti materialises its fs cache with a recursive mkdir and the process umask, so under umask 002 it
 * leaves the cache root group-writable (0775). The platform temp-root guard refuses to place a
 * workspace under any group/world-writable ancestor, and its fallback refuses for the same reason —
 * measured 2026-11-08: the doctor persistence test failed with "No safe OpenClaw temp root is
 * available … Temp workspace ancestor is group/world writable without sticky protection", and the
 * state fallback failed identically. Creating the two directories OpenClaw owns at 0700 first makes
 * jiti reuse them instead of creating them wide, and repairs an already-permissive one.
 *
 * The cache ROOT itself (XDG_CACHE_HOME or ~/.cache) is only created when absent: it may belong to
 * the user or to another application, so an existing mode there is left as its owner set it.
 */
export function ensurePrivateJitiCacheRoots(cacheRoot: string, fsCache: string): void {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    for (const directory of [path.join(cacheRoot, "openclaw"), fsCache]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    }
  } catch (error) {
    // A cache we cannot prepare is jiti's error to raise, not ours — but never silently: this is the
    // exact refusal the function exists to prevent, so it is reported where the operator can see it.
    console.warn(
      `[plugins] could not prepare a private jiti cache under ${cacheRoot}: ${formatErrorMessage(error)}`,
    );
  }
}
