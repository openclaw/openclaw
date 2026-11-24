import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/**
 * The worker-code generation of the whole process, set while an updater retains its running
 * runtime. Async-context bindings cover work started inside the update; process-wide owners
 * (state lease heartbeats, the file-log pool) start workers from detached or earlier contexts
 * and must still load the retained copy once activation has replaced the installed package.
 */
const holder = resolveGlobalSingleton(
  Symbol.for("openclaw.processRuntimeWorkerGeneration"),
  (): { resolve?: (url: URL) => URL } => ({}),
);

export function setProcessRuntimeWorkerResolver(resolve: ((url: URL) => URL) | undefined): void {
  holder.resolve = resolve;
}

/** Map a worker script to the retained runtime when this process retains one. */
export function resolveProcessRuntimeWorkerFile<T extends string | URL>(
  filename: T,
): T | URL | string {
  const resolve = holder.resolve;
  if (!resolve) {
    return filename;
  }
  if (filename instanceof URL) {
    return filename.protocol === "file:" ? resolve(filename) : filename;
  }
  if (typeof filename === "string" && filename.startsWith("/")) {
    const resolved = resolve(pathToFileURL(filename));
    return resolved.protocol === "file:" ? fileURLToPath(resolved) : filename;
  }
  return filename;
}
