import path from "node:path";
import { safeReadDir } from "./state-migrations.fs.js";
import { resolveLegacyMigrationSourcePath } from "./state-migrations.source-path.js";

export const LEGACY_DELIVERY_QUEUE_DIRS = [
  { label: "outbound delivery queue", queueName: "outbound", dirName: "delivery-queue" },
  { label: "session delivery queue", queueName: "session", dirName: "session-delivery-queue" },
] as const;
type LegacyDeliveryQueueFile = {
  sourcePath: string;
  claimPaths: string[];
  status: "pending" | "failed";
};

export function resolveLegacyDeliveryQueuePath(stateDir: string, dirName: string): string {
  return path.join(stateDir, dirName);
}

export function listLegacyDeliveryQueueFiles(queueDir: string): LegacyDeliveryQueueFile[] {
  const files = (directory: string) => {
    const sources = new Map<string, { sourcePath: string; claimPaths: string[] }>();
    for (const entry of safeReadDir(directory)) {
      const name = resolveLegacyMigrationSourcePath(entry.name);
      if (!entry.isFile() || !name.endsWith(".json")) {
        continue;
      }
      const source = sources.get(name) ?? {
        sourcePath: path.join(directory, name),
        claimPaths: [],
      };
      if (entry.name !== name) {
        source.claimPaths.push(path.join(directory, entry.name));
      }
      sources.set(name, source);
    }
    return [...sources.values()];
  };
  const pending = files(queueDir).map((source) => ({
    ...source,
    status: "pending" as const,
  }));
  const failedDir = path.join(queueDir, "failed");
  const failed = files(failedDir).map((source) => ({
    ...source,
    status: "failed" as const,
  }));
  return [...pending, ...failed];
}

export function listLegacyDeliveryQueueDeliveredMarkers(queueDir: string): string[] {
  return safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
    .map((entry) => path.join(queueDir, entry.name));
}

/** Read-only inventory shared by Doctor and Gateway diagnostics. */
export function listLegacyDeliveryQueueArtifacts(stateDir: string): string[] {
  return LEGACY_DELIVERY_QUEUE_DIRS.flatMap(({ dirName }) => {
    const directory = resolveLegacyDeliveryQueuePath(stateDir, dirName);
    return listLegacyDeliveryQueueFiles(directory)
      .map((file) => file.sourcePath)
      .concat(listLegacyDeliveryQueueDeliveredMarkers(directory));
  });
}

export function detectLegacyDeliveryQueueFiles(stateDir: string) {
  return {
    outboundPath: resolveLegacyDeliveryQueuePath(stateDir, "delivery-queue"),
    sessionPath: resolveLegacyDeliveryQueuePath(stateDir, "session-delivery-queue"),
    hasLegacy: listLegacyDeliveryQueueArtifacts(stateDir).length > 0,
  };
}
