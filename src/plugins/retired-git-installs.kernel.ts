// Pure retirement-record merge. The shared-state worker applies it inside one
// transaction; callers never send a function across the worker boundary.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Existing machine-state row. Install records stay unchanged. */
export const RETIRED_GIT_INSTALLS_STATE_KEY = "plugins.retiredGitInstalls";

export type RetiredGitInstallMarker = {
  version: 1;
  pluginId: string;
  target: string;
  parentDir: string;
  dev: string;
  ino: string;
};

export type RetiredGitInstallStateReplacement =
  | { action: "remember"; marker: RetiredGitInstallMarker }
  | { action: "forget"; targets: readonly string[]; dropUnreadable: boolean };

export function retiredGitInstallMarkerFrom(value: unknown): RetiredGitInstallMarker | null {
  if (!isRecord(value)) {
    return null;
  }
  const { version, pluginId, target, parentDir, dev, ino } = value;
  if (
    version !== 1 ||
    typeof pluginId !== "string" ||
    typeof target !== "string" ||
    typeof parentDir !== "string" ||
    typeof dev !== "string" ||
    typeof ino !== "string"
  ) {
    return null;
  }
  return { version, pluginId, target, parentDir, dev, ino };
}

export function nextRetiredGitInstallRecords(
  current: unknown[] | undefined,
  replacement: RetiredGitInstallStateReplacement,
): unknown[] | undefined {
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error("retired git install record is unreadable");
  }
  const records = current ?? [];
  if (replacement.action === "remember") {
    const target = path.resolve(replacement.marker.target);
    return [
      ...records.filter((entry) => {
        const existing = retiredGitInstallMarkerFrom(entry);
        return !existing || path.resolve(existing.target) !== target;
      }),
      replacement.marker,
    ];
  }
  const targets = new Set(replacement.targets.map((target) => path.resolve(target)));
  const kept = records.filter((entry) => {
    const existing = retiredGitInstallMarkerFrom(entry);
    if (!existing) {
      return !replacement.dropUnreadable;
    }
    return !targets.has(path.resolve(existing.target));
  });
  return kept.length > 0 ? kept : undefined;
}
