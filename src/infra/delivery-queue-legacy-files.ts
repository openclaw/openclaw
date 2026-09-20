import path from "node:path";
import { safeReadDir } from "./state-migrations.fs.js";

export const LEGACY_DELIVERY_QUEUE_DIRS = [
  { label: "outbound delivery queue", queueName: "outbound", dirName: "delivery-queue" },
  { label: "session delivery queue", queueName: "session", dirName: "session-delivery-queue" },
] as const;
type LegacyDeliveryQueueFile = {
  sourcePath: string;
  status: "pending" | "failed";
};

export function resolveLegacyDeliveryQueuePath(stateDir: string, dirName: string): string {
  return path.join(stateDir, dirName);
}

export function listLegacyDeliveryQueueFiles(queueDir: string): LegacyDeliveryQueueFile[] {
  const pending = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ sourcePath: path.join(queueDir, entry.name), status: "pending" as const }));
  const failedDir = path.join(queueDir, "failed");
  const failed = safeReadDir(failedDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      sourcePath: path.join(failedDir, entry.name),
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
