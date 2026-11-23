import fs from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import {
  createRuntimeProcessEntrypoints,
  pluginRuntimeProcessManifest,
  runtimeProcessSealedManifest,
} from "./runtime-process-manifest.js";

export const MAX_DIAGNOSTIC_WORKER_SLOTS = 64;

const scriptBasename = (filename: string) => basename(filename).replace(/\.[cm]?[jt]s$/u, ".js");
const entries = createRuntimeProcessEntrypoints(import.meta.url);
const workerScripts = new Map<string, string>();
for (const entry of Object.values(entries)) {
  const script = scriptBasename(entry.distWorkerPath);
  workerScripts.set(script, script);
  workerScripts.set(scriptBasename(entry.sourceModulePath), script);
}
for (const entry of Object.values(pluginRuntimeProcessManifest)) {
  const script = scriptBasename(entry.distWorkerPath);
  workerScripts.set(script, script);
  workerScripts.set(scriptBasename(entry.package.distWorkerPath), script);
  workerScripts.set(scriptBasename(`${entry.sourceWorkerName}.js`), script);
}
for (const group of Object.values(runtimeProcessSealedManifest)) {
  for (const [owner, name] of group.entries) {
    const script = scriptBasename(`${name}.mjs`);
    if (!workerScripts.has(script)) {
      workerScripts.set(script, scriptBasename(entries[owner].distWorkerPath));
    }
  }
}
const workerScriptNames = new Set(workerScripts.values());

/** Imported diagnostics may contain arbitrary paths or names. Preserve only known scripts. */
export function normalizeDiagnosticWorkerScript(value: unknown): string {
  return typeof value === "string" && workerScriptNames.has(value) ? value : "other";
}

export function workerScriptName(filename: string | URL, evalSource = false): string {
  // Never retain eval source, arbitrary filenames, or installation paths in diagnostics.
  if (evalSource || (filename instanceof URL && filename.protocol !== "file:")) {
    return "other";
  }
  return (
    workerScripts.get(
      scriptBasename(filename instanceof URL ? fileURLToPath(filename) : filename),
    ) ?? "other"
  );
}

/** Resolve only when emitting a diagnostic; Node thread IDs are not Linux task IDs. */
export function currentWorkerDiagnosticIdentity() {
  let nativeThreadId: number | undefined;
  if (process.platform === "linux") {
    try {
      nativeThreadId = Number(basename(fs.readlinkSync("/proc/thread-self")));
    } catch {
      // Procfs can be unavailable; attribution must not suppress the original diagnostic.
    }
  }
  return {
    workerScript: isMainThread ? "main" : workerScriptName(process.argv[1] ?? ""),
    ...(nativeThreadId !== undefined && Number.isSafeInteger(nativeThreadId) && nativeThreadId > 0
      ? { nativeThreadId }
      : {}),
  };
}
