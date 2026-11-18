export async function* collectWorkspaceSuggestionNotes(workspaceDir: string) {
  const { collectWorkspaceBackupTip, MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
    await import("./doctor-workspace.js");
  const backupTip = collectWorkspaceBackupTip(workspaceDir);
  if (backupTip) {
    yield backupTip;
  }
  if (await shouldSuggestMemorySystem(workspaceDir)) {
    yield MEMORY_SYSTEM_PROMPT;
  }
}
