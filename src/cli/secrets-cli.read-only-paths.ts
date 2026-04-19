/**
 * Command paths that MUST run with the auth store forced into read-only mode.
 *
 * The entry script (`src/entry.ts`) imports this manifest before Commander
 * parses argv and sets `OPENCLAW_AUTH_STORE_READONLY=1` whenever the caller's
 * argv matches an entry here. Each entry is a token path from the program root
 * to the target subcommand (for example, `["secrets", "audit"]` matches
 * `openclaw secrets audit`).
 *
 * Binding sites:
 * - Consumer: `src/entry.ts` — argv gate runs before any module reads the env.
 * - Registration: `src/cli/secrets-cli.ts` — each manifest entry MUST resolve
 *   to a real Commander subcommand path. The regression guard in
 *   `src/cli/secrets-cli.read-only-paths.test.ts` walks the registered command
 *   tree and fails if a manifest entry drifts from the actual command names.
 *   Renaming a command without updating this manifest therefore breaks CI
 *   instead of silently dropping the read-only guarantee.
 *
 * The entry-side matcher filters tokens starting with `-` before matching, so
 * option arguments do not interrupt adjacent-token pairs. Do not add a path
 * component that itself begins with `-`; Commander subcommand names do not use
 * leading dashes, so this constraint is a note for future maintainers rather
 * than a current limitation.
 */
export const READ_ONLY_AUTH_COMMAND_PATHS: readonly (readonly string[])[] = [
  ["secrets", "audit"],
] as const;
