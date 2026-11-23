// Exposes boundary path resolution helpers with fs-safe defaults.
import path from "node:path";
import { resolvePathViaExistingAncestorSync as resolvePathViaExistingAncestorSyncRaw } from "@openclaw/fs-safe/advanced";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
export { safeRealpathSync } from "@openclaw/fs-safe/path";

// Bun follow-up: Remove this stable frame after fs-safe drops its N-API realpath
// workaround for oven-sh/bun#42374. Its process-lived callback must not retain
// the first request context that resolves a missing path.
export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  return runInDetachedAsyncContext(() => resolvePathViaExistingAncestorSyncRaw(targetPath));
}

/** Returns a canonical path when resolvable, otherwise an absolute lexical path. */
export function resolveRealpathOrAbsolute(value: string): string {
  return safeRealpathSync(value) ?? path.resolve(value);
}

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
export { resolveRootPath, resolveRootPathSync } from "@openclaw/fs-safe/advanced";
