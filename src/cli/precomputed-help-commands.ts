export const PRECOMPUTED_SUBCOMMAND_HELP_NAMES = [
  "config",
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
] as const;

export type PrecomputedSubcommandHelpName = (typeof PRECOMPUTED_SUBCOMMAND_HELP_NAMES)[number];
