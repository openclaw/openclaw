import fs from "node:fs";
import { isPathInside } from "../infra/path-guards.js";
import {
  createPluginNativeAdmission,
  type PluginNativeRecovery,
} from "./plugin-native-admission.js";

export type PluginGenerationCaptureBudget = {
  maxEntries: number;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type PluginGenerationCaptureOptions =
  | PluginGenerationCaptureBudget
  | { copyNativeFiles: true };

export function pluginGenerationCaptureBudget(
  options?: PluginGenerationCaptureOptions,
): PluginGenerationCaptureBudget | undefined {
  return options && "maxEntries" in options ? options : undefined;
}

export function createPluginGenerationCaptureBudget(
  rootDir: string,
  budget?: PluginGenerationCaptureBudget,
) {
  const canonicalRootDir = fs.realpathSync(rootDir);
  let fileCount = 0;
  let byteCount = 0;
  let totalByteCount = 0;
  let entryCount = 0;
  const reserveEntry = () => {
    entryCount += 1;
    if (budget && entryCount > budget.maxEntries) {
      throw new Error("Plugin source capture exceeds its entry budget");
    }
  };
  const reserveFile = (source: string, sizeBytes: number) => {
    totalByteCount += sizeBytes;
    if (budget && (sizeBytes > budget.maxFileBytes || totalByteCount > budget.maxTotalBytes)) {
      throw new Error("Plugin source capture exceeds its total byte budget");
    }
    if (!isPathInside(canonicalRootDir, source)) {
      return;
    }
    fileCount += 1;
    byteCount += sizeBytes;
    if (budget && (fileCount > budget.maxFiles || byteCount > budget.maxBytes)) {
      throw new Error("Plugin source capture exceeds its file budget");
    }
  };
  return {
    directoryEntryLimit: budget?.maxEntries,
    reserveEntry,
    reserveFile,
    readDirectoryNames(directory: string): string[] {
      const names: string[] = [];
      const handle = fs.opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          reserveEntry();
          names.push(entry.name);
        }
      } finally {
        handle.closeSync();
      }
      return names.toSorted();
    },
  };
}

export function createBudgetedPluginNativeAdmission(params: {
  rootDir: string;
  directory: string;
  entryFiles?: readonly string[];
  recovery?: PluginNativeRecovery;
  outputRoot?: string;
  captureOptions?: PluginGenerationCaptureOptions;
  hardlinkedSources?: Set<string>;
}) {
  const captureBudget = pluginGenerationCaptureBudget(params.captureOptions);
  const budget = createPluginGenerationCaptureBudget(params.rootDir, captureBudget);
  const hardlinkedSources = params.hardlinkedSources ?? new Set<string>();
  const nativeAdmission = createPluginNativeAdmission(
    params.rootDir,
    params.directory,
    params.entryFiles,
    params.recovery,
    params.outputRoot,
    captureBudget
      ? {
          onDirectoryEntry: budget.reserveEntry,
          onSourceDescriptor(source, stat, admittedHardlink) {
            budget.reserveFile(source, Number(stat.size));
            if (stat.nlink > 1n && !admittedHardlink) {
              hardlinkedSources.add(source);
            }
          },
        }
      : undefined,
    params.captureOptions !== captureBudget,
  );
  return { budget, nativeAdmission, hardlinkedSources };
}
