import path from "node:path";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";

type Entry = UpdateRecoveryBackupManifest["entries"][number];
type ResourceKind = "file" | "directory" | "sqlite";

/** B's immutable target entry owns an alias's capture method, even if its producer
 * removes the declaration, the alias disappears or its current target changes.
 * Never derive that historic kind from the current filesystem or alias suffix. */
export function retainedUpdateRecoveryResources(manifest?: UpdateRecoveryBackupManifest): Array<{
  path: string;
  kind: ResourceKind;
}> {
  const entries = new Map(manifest?.entries.map((entry) => [entry.sourcePath, entry]));
  function kind(entry: Entry, followed = new Set<string>()): ResourceKind {
    if (entry.kind === "directory") {
      return "directory";
    }
    if (entry.kind === "file") {
      return entry.sqlite ? "sqlite" : "file";
    }
    if (entry.kind === "missing") {
      return entry.directory ? "directory" : entry.sqlite ? "sqlite" : "file";
    }
    if (followed.has(entry.sourcePath)) {
      throw new Error("Retained recovery aliases form a cycle.");
    }
    followed.add(entry.sourcePath);
    // Earlier v2 captures can omit contentPath for non-config aliases. Resolve
    // only their literal link text against captured entries, never a live realpath.
    const targetPath =
      entry.contentPath ?? path.resolve(path.dirname(entry.sourcePath), entry.target);
    const target = entries.get(targetPath);
    if (!target) {
      throw new Error(`Retained recovery alias has no captured target kind: ${entry.sourcePath}`);
    }
    return kind(target, followed);
  }
  return [...entries.values()].map((entry) => ({ path: entry.sourcePath, kind: kind(entry) }));
}
