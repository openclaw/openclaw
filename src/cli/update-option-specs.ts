// Shared by Commander registration and command discovery before runtime bootstrap.
export const UPDATE_OPTION_SPECS: readonly [
  flags: string,
  description: string,
  defaultValue?: boolean,
][] = [
  ["--json", "Output result as JSON", false],
  ["--no-restart", "Skip updater restart (package Gateways may restart themselves)"],
  ["--dry-run", "Preview update actions without making changes", false],
  ["--full-integrity-check", "No effect; accepted for existing scripts", false],
  ["--admission <auto|installed>", "No effect; accepted for existing scripts"],
  ["--channel <stable|extended-stable|beta|dev>", "Persist update channel (git + npm)"],
  [
    "--tag <dist-tag|version|spec>",
    "Override the package target for this update (dist-tag, version, or package spec)",
  ],
  ["--timeout <seconds>", "Set an overall update budget in seconds"],
  ["--drain-timeout <seconds>", "Set the immutable activation drain budget before interruption"],
  ["--sha <commit>", "Update a git checkout or immutable installation to an exact commit"],
  ["--yes", "Skip confirmation prompts (non-interactive)", false],
  ["--reapply-local-overrides", "No effect; accepted for existing scripts", false],
  ["--accept-capabilities", "No effect; accepted for existing scripts", false],
];
