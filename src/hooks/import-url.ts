/**
 * Build an import URL for a hook handler module.
 *
 * Bundled hooks (shipped in dist/) are immutable between installs, so they
 * can be imported without a cache-busting suffix — letting V8 reuse its
 * module cache across gateway restarts.
 *
 * Workspace, managed, and plugin hooks may be edited by the user between
 * restarts.  For those we append `?t=<mtime>` so the module is only
 * re-parsed when the file actually changes on disk.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { HookSource } from "./types.js";

/**
 * Sources whose handler files never change between `npm install` runs.
 * Imports from these sources skip cache busting entirely.
 */
const IMMUTABLE_SOURCES: ReadonlySet<HookSource> = new Set(["openclaw-bundled"]);

export function buildImportUrl(handlerPath: string, source: HookSource): string {
  const base = pathToFileURL(handlerPath).href;

  if (IMMUTABLE_SOURCES.has(source)) {
    return base;
  }

  // Use file mtime so the cache is only invalidated when the file is modified
  try {
    const { mtimeMs } = fs.statSync(handlerPath);
    return `${base}?t=${mtimeMs}`;
  } catch {
    // If stat fails (unlikely), fall back to Date.now() to guarantee freshness
    return `${base}?t=${Date.now()}`;
  }
}
