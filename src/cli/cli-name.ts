import path from "node:path";

const DEFAULT_CLI_NAME = "openclaw";

/** ClaWorks CLI binary name */
export const CLAWORKS_CLI_NAME = "claworks";
/** OpenClaw CLI binary name */
export const OPENCLAW_CLI_NAME = "openclaw";

/** Detect ClaWorks product mode via environment variable */
export function isClaworksCliProduct(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWORKS_PRODUCT === "1" || env.CLAWORKS_PRODUCT === "true";
}

/** Resolve display title for the given CLI name */
export function resolveCliProductTitle(cliName: string): string {
  return cliName === CLAWORKS_CLI_NAME ? "ClaWorks" : "OpenClaw";
}

/** Resolve emoji for the given CLI name */
export function resolveCliProductEmoji(cliName: string): string {
  return cliName === CLAWORKS_CLI_NAME ? "🦅" : "🦞";
}

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME, CLAWORKS_CLI_NAME]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw|claworks)\b/;

export function resolveCliName(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const argv1 = argv[1];
  if (argv1) {
    const base = path.basename(argv1).trim();
    if (KNOWN_CLI_NAMES.has(base)) {
      return base;
    }
  }
  // Fall back to env: set by claworks.mjs wrapper when spawning openclaw.mjs
  if (isClaworksCliProduct(env)) {
    return CLAWORKS_CLI_NAME;
  }
  return DEFAULT_CLI_NAME;
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

/** Replace embedded `openclaw <subcommand>` tokens in user-visible copy. */
const EMBEDDED_CLI_NAME_RE = /(^|[\s`'"])openclaw(?=[\s`]|$|[.,;:!?])/g;

export function replaceEmbeddedCliNames(value: string, cliName = resolveCliName()): string {
  return value.replace(EMBEDDED_CLI_NAME_RE, `$1${cliName}`);
}
