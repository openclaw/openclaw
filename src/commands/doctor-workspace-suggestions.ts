import type { OpenClawConfig } from "../config/types.openclaw.js";

export async function* collectWorkspaceSuggestionNotes(
  workspaceDir: string,
  opts?: { cfg?: OpenClawConfig },
) {
  const { collectWorkspaceBackupTip, MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
    await import("./doctor-workspace.js");
  const backupTip = collectWorkspaceBackupTip(workspaceDir);
  if (backupTip) {
    yield backupTip;
  }
  const hasPluginMemory =
    opts?.cfg !== undefined &&
    (await import("./doctor-memory-search.js")).hasActiveAlternateMemoryPluginSlot(opts.cfg);
  if (!hasPluginMemory && (await shouldSuggestMemorySystem(workspaceDir))) {
    yield MEMORY_SYSTEM_PROMPT;
  }
}
