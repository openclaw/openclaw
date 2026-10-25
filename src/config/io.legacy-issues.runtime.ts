import { findLegacyConfigIssues } from "./legacy.js";
import type { LegacyConfigIssue } from "./types.js";

export async function collectInvalidConfigLegacyIssues(
  raw: unknown,
  sourceRaw: unknown,
  options: {
    coreOnly: boolean;
    preparePluginDiagnostics?: () => Promise<() => void>;
  },
): Promise<LegacyConfigIssue[]> {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  // Known core repairs must not wait for executable plugin diagnostics or their state reads.
  const coreIssues = findLegacyConfigIssues(raw, sourceRaw);
  if (options.coreOnly || coreIssues.length > 0) {
    return coreIssues;
  }
  const { findDoctorLegacyConfigIssues } =
    await import("../commands/doctor/shared/legacy-config-issues.js");
  const activatePluginState = await options.preparePluginDiagnostics?.();
  activatePluginState?.();
  return findDoctorLegacyConfigIssues(raw, sourceRaw);
}
