import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { HookSource } from "./types.js";

export function buildImportUrl(handlerPath: string, source: HookSource): string {
  const base = pathToFileURL(handlerPath).href;

  // Bundled hooks are immutable between installs; other sources may change between restarts.
  if (source === "openclaw-bundled") {
    return base;
  }

  // ctime detects same-size edits even when mtime is restored.
  try {
    const { ctimeMs, mtimeMs, size } = fs.statSync(handlerPath);
    return `${base}?t=${mtimeMs}&c=${ctimeMs}&s=${size}`;
  } catch {
    // Missing metadata still requires a fresh import.
    return `${base}?t=${Date.now()}`;
  }
}
