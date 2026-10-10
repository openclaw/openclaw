import { resolveCliParentCommandPath } from "./parent-command-path.js";

/** Config values, paths, and schemas reserve stdout for machine-consumed output. */
export function isConfigMachineOutput(argv: readonly string[]): boolean {
  const subcommand = resolveCliParentCommandPath(argv, "config")?.[1];
  return subcommand === "get" || subcommand === "file" || subcommand === "schema";
}

/** Config set uses --json as a parser alias except when dry-run emits a JSON report. */
export function isConfigSetJsonParseOnly(argv: readonly string[]): boolean {
  const terminator = argv.indexOf("--", 2);
  const options = new Set(argv.slice(2, terminator < 0 ? undefined : terminator));
  return options.has("--json") && !options.has("--dry-run");
}
