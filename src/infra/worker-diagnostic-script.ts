import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeProcessEntrypoints } from "./runtime-process-manifest.js";

export const MAX_DIAGNOSTIC_WORKER_SLOTS = 64;

const workerScriptNames = new Set([
  ...Object.values(createRuntimeProcessEntrypoints(import.meta.url)).map((entry) =>
    basename(entry.distWorkerPath),
  ),
  // Pools with source/standalone-plugin entrypoints outside the process manifest.
  "catalog-page.worker.js",
  "code-mode.worker.js",
  "disk-budget.worker.js",
  "document-extractor.worker.js",
  "manager-index.worker.js",
  "manager-search.worker.js",
  "memory-index.worker.js",
  "memory-search.worker.js",
  "session-history.worker.js",
  "audio-worker.runtime.js",
  "realtime-quicksilver-audio.worker.js",
  "realtime-quicksilver-socket.worker.js",
  "telegram-ingress-worker.runtime.js",
]);

/** Imported diagnostics may contain arbitrary paths or names. Preserve only known scripts. */
export function normalizeDiagnosticWorkerScript(value: unknown): string {
  return typeof value === "string" && workerScriptNames.has(value) ? value : "other";
}

export function workerScriptName(filename: string | URL, evalSource = false): string {
  // Never retain eval source, arbitrary filenames, or installation paths in diagnostics.
  if (evalSource || (filename instanceof URL && filename.protocol !== "file:")) {
    return "other";
  }
  const name = basename(filename instanceof URL ? fileURLToPath(filename) : filename).replace(
    /\.[cm]?[jt]s$/u,
    ".js",
  );
  return normalizeDiagnosticWorkerScript(name);
}
