/** Warm the same Doctor paths before per-case timing and mock resets. */
export async function warmDoctorConfigFlow(
  collectDoctorWarnings: (config: Record<string, unknown>) => Promise<string[]>,
): Promise<void> {
  await Promise.all([
    import("../config/plugin-auto-enable.js"),
    import("./doctor/repair-sequencing.js"),
    import("./doctor/shared/channel-doctor.js"),
    import("./doctor/shared/legacy-config-issues.js"),
    import("./doctor/shared/plugin-tool-allowlist-warnings.js"),
    import("./doctor/shared/preview-warnings.js"),
    import("./doctor/shared/hooks-token-reuse-repair.js"),
  ]);
  await collectDoctorWarnings({
    channels: {
      slack: {
        dangerouslyAllowNameMatching: true,
        accounts: { work: { allowFrom: ["alice"] } },
      },
    },
  });
  await collectDoctorWarnings({
    channels: {
      googlechat: {
        groupPolicy: "allowlist",
        accounts: { work: { groupPolicy: "allowlist" } },
      },
    },
  });
}
