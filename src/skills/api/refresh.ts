import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";

/** Invalidate cached skill snapshots and return the version containing subsequent reads. */
export function refreshSkillsSnapshot(workspaceDir: string): number {
  return bumpSkillsSnapshotVersion({ workspaceDir, reason: "manual" });
}
