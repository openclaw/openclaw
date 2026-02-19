import path from "node:path";
import { isMabosProduct } from "../config/paths.js";

export const DEFAULT_CLI_NAME = "openclaw";

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME, "mabos"]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw|mabos)\b/;

/** Resolved CLI name, respecting MABOS_PRODUCT env when argv doesn't match. */
export function resolvedProductName(): string {
  return isMabosProduct() ? "mabos" : DEFAULT_CLI_NAME;
}

export function resolveCliName(argv: string[] = process.argv): string {
  const argv1 = argv[1];
  if (!argv1) {
    return resolvedProductName();
  }
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  return resolvedProductName();
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
