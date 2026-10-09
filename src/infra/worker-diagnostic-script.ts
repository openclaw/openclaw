import { basename } from "node:path";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { standaloneKinds } from "./worker-request-kind.js";

const workerScriptNames = new Set([
  ...Object.values(runtimeProcessEntrypoints).map((entry) => basename(entry.distWorkerPath)),
  // Pools with source/standalone-plugin entrypoints outside the process manifest.
  ...Object.keys(standaloneKinds).filter((script) => script !== "run.worker.js"),
  "audio-worker.runtime.js",
  "realtime-quicksilver-audio.worker.js",
  "realtime-quicksilver-socket.worker.js",
  "telegram-ingress-worker.runtime.js",
]);

/** Imported diagnostics may contain arbitrary paths or names. Preserve only known scripts. */
export function normalizeDiagnosticWorkerScript(value: unknown): string {
  return typeof value === "string" && workerScriptNames.has(value) ? value : "other";
}
