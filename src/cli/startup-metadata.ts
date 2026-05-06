import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryReadJsonSync } from "../infra/json-files.js";

const STARTUP_METADATA_FILE = "cli-startup-metadata.json";
const startupMetadataByPath = new Map<string, Record<string, unknown> | null>();

function resolveStartupMetadataPathCandidates(moduleUrl: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(moduleDir, STARTUP_METADATA_FILE),
    path.resolve(moduleDir, "..", STARTUP_METADATA_FILE),
  ];
}

export function readCliStartupMetadata(moduleUrl: string): Record<string, unknown> | null {
  for (const metadataPath of resolveStartupMetadataPathCandidates(moduleUrl)) {
    const cached = startupMetadataByPath.get(metadataPath);
    if (cached !== undefined) {
      if (cached) {
        return cached;
      }
      continue;
    }
    const parsed = tryReadJsonSync<Record<string, unknown>>(metadataPath);
    if (parsed) {
      startupMetadataByPath.set(metadataPath, parsed);
      return parsed;
    }
    // Try the next bundled/source layout before falling back to dynamic startup work.
    startupMetadataByPath.set(metadataPath, null);
  }
  return null;
}

export const __testing = {
  resolveStartupMetadataPathCandidates,
  clearStartupMetadataCache(): void {
    startupMetadataByPath.clear();
  },
};
