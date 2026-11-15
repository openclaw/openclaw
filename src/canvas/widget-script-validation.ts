import { createHash } from "node:crypto";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { parseWidgetScript, type WidgetScript } from "./widget-script-parse.js";

type ScriptError = ReturnType<typeof parseWidgetScript>;
// Retain only digests and bounded diagnostics, never scripts or their ASTs.
const results = new Map<string, Promise<ScriptError>>();
let pool: WorkerTaskPool<WidgetScript, ScriptError> | undefined;

export function validateWidgetScript(script: WidgetScript): Promise<ScriptError> {
  const key = createHash("sha256")
    .update(script.sourceType)
    .update(script.body, "utf16le")
    .digest("hex");
  const cached = results.get(key);
  if (cached) {
    results.delete(key);
    results.set(key, cached);
    return cached;
  }
  // Stay below a typical 10 ms parse; large cold scripts use the shared compute budget.
  const result =
    script.body.length < 32 * 1024
      ? Promise.resolve(parseWidgetScript(script))
      : (pool ??= new WorkerTaskPool({
          workerUrl: resolveRuntimeProcessEntrypointUrl("widgetScriptSyntax"),
          workerClass: "compute",
          sharedCompute: true,
        })).run(script, { inputBytes: script.body.length * 2 });
  results.set(key, result);
  if (results.size > 128) {
    results.delete(results.keys().next().value!);
  }
  void result.catch(() => {
    if (results.get(key) === result) {
      results.delete(key);
    }
  });
  return result;
}
