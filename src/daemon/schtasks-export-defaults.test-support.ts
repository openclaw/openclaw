// Values independently specified by Microsoft's Task Scheduler schema and omitted
// by windows-2025 in the retained published-updater qualification (35500397312).
export const exportedTaskDefaults = [
  ["Triggers.LogonTrigger.Enabled", "true", "false"],
  ["Settings.AllowHardTerminate", "true", "false"],
  ["Settings.StartWhenAvailable", "false", "true"],
  ["Settings.RunOnlyIfNetworkAvailable", "false", "true"],
  ["Settings.AllowStartOnDemand", "true", "false"],
  ["Settings.Hidden", "false", "true"],
  ["Settings.RunOnlyIfIdle", "false", "true"],
  ["Settings.WakeToRun", "false", "true"],
  ["Settings.Priority", "7", "4"],
] as const;

export function omitExportedTaskDefaults(xml: string): string {
  let exported = xml;
  for (const [key, value] of exportedTaskDefaults) {
    const tag = key.split(".").at(-1)!;
    // The first Enabled belongs to LogonTrigger; Settings.Enabled is independent.
    exported = exported.replace(`<${tag}>${value}</${tag}>`, "");
  }
  return exported;
}
