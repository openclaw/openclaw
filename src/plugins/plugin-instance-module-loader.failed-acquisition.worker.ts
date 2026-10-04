import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

type FailedAcquisitionResult = {
  failure: string;
  loadError: string;
  marker: string;
  rejected: string;
  afterFailedDispose: string;
};

function workerPaths(): { rootDir: string; sourceCaptureDirectory: string } {
  if (
    workerData === null ||
    typeof workerData !== "object" ||
    !("rootDir" in workerData) ||
    !("sourceCaptureDirectory" in workerData) ||
    typeof workerData.rootDir !== "string" ||
    typeof workerData.sourceCaptureDirectory !== "string"
  ) {
    throw new Error("catalog worker data missing");
  }
  return {
    rootDir: workerData.rootDir,
    sourceCaptureDirectory: workerData.sourceCaptureDirectory,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readMarker(value: unknown): string {
  if (typeof value !== "object" || value === null || !("marker" in value)) {
    return "";
  }
  return typeof value.marker === "string" ? value.marker : "";
}

const { rootDir, sourceCaptureDirectory } = workerPaths();
const source = path.join(rootDir, "index.mjs");
const side = path.join(rootDir, "side.mjs");
const failed = new PluginInstance("failed-acquisition");
const loaded = new PluginInstance("loaded-acquisition");
const cache = createPluginCache();
const result: FailedAcquisitionResult = {
  failure: "",
  loadError: "",
  marker: "",
  rejected: "",
  afterFailedDispose: "",
};

try {
  await withPluginSourceCaptureDirectory(sourceCaptureDirectory, async () => {
    try {
      withPluginCache(cache, () =>
        bindPluginInstanceModuleLoader({
          instance: failed,
          origin: "config",
          source,
          rootDir,
          expectedSourceDigest: "0".repeat(64),
        }),
      );
    } catch (error) {
      result.failure = message(error);
    }
    try {
      withPluginCache(cache, () =>
        bindPluginInstanceModuleLoader({
          instance: loaded,
          origin: "config",
          source,
          rootDir,
        }),
      );
      result.marker = readMarker(loaded.loadModule(source));
    } catch (error) {
      result.loadError = message(error);
    }
    if (!result.loadError) {
      try {
        await failed.run(() => import(pathToFileURL(side).href));
        result.rejected = "admitted";
      } catch (error) {
        result.rejected = message(error);
      }
      await failed.dispose();
      result.afterFailedDispose = readMarker(loaded.loadModule(source));
    }
  });
} catch (error) {
  result.loadError = result.loadError || message(error);
} finally {
  await loaded.dispose();
  parentPort?.postMessage(result, []);
}
