import type { RuntimeEnv } from "../../runtime.js";
import {
  addFallbackCommand,
  clearFallbacksCommand,
  listFallbacksCommand,
  removeFallbackCommand,
} from "./fallbacks-shared.js";

export async function modelsImageFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  return await listFallbacksCommand({ label: "Image fallbacks", key: "imageModel" }, opts, runtime);
}

export async function modelsImageFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await addFallbackCommand(
    { label: "Image fallbacks", key: "imageModel", logPrefix: "Image fallbacks" },
    modelRaw,
    runtime,
  );
}

export async function modelsImageFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await removeFallbackCommand(
    {
      label: "Image fallbacks",
      key: "imageModel",
      notFoundLabel: "Image fallback",
      logPrefix: "Image fallbacks",
    },
    modelRaw,
    runtime,
  );
}

export async function modelsImageFallbacksClearCommand(runtime: RuntimeEnv) {
  return await clearFallbacksCommand(
    { key: "imageModel", clearedMessage: "Image fallback list cleared." },
    runtime,
  );
}
