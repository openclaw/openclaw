// Shared by Commander registration and command discovery before runtime bootstrap.
export const UPDATE_OPTION_SPECS: readonly [
  flags: string,
  description: string,
  defaultValue?: boolean,
][] = [
  ["--json", "Output result as JSON", false],
  ["--no-restart", "Skip updater restart (package Gateways may restart themselves)"],
  ["--dry-run", "Preview update actions without making changes", false],
  [
    "--full-integrity-check",
    "Unavailable for prepared-release updates; use openclaw doctor --fix --full-integrity-check",
    false,
  ],
  [
    "--admission <auto|installed>",
    "Select candidate or installed admission checks (default: auto)",
  ],
  ["--channel <stable|extended-stable|beta|dev>", "Persist update channel (git + npm)"],
  [
    "--tag <dist-tag|version|spec>",
    "Override the package target for this update (dist-tag, version, or package spec)",
  ],
  ["--timeout <seconds>", "Set an overall update budget in seconds"],
  ["--drain-timeout <seconds>", "Set the immutable activation drain budget before interruption"],
  ["--sha <commit>", "Prepare an exact official commit for an adopted immutable installation"],
  ["--yes", "Skip confirmation prompts (non-interactive)", false],
  [
    "--reapply-local-overrides",
    "Compatibility option; prepared releases require saving and manually reapplying local dist edits",
    false,
  ],
  ["--accept-capabilities", "Accept widened plugin capabilities", false],
];
