import { loadConfig } from "../config/config.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { visibleWidth } from "../terminal/ansi.js";
import { isRich, theme } from "../terminal/theme.js";
import { getPrimaryCommand, hasRootVersionAlias } from "./argv.js";
import { readCliBannerTaglineMode } from "./banner-config-lite.js";
import {
  pickTagline,
  resolveScriptTagline,
  type TaglineMode,
  type TaglineOptions,
} from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  columns?: number;
  richTty?: boolean;
};

let bannerEmitted = false;
// Cached script tagline resolved during emitCliBanner so that formatCliBannerLine
// (which is sync) can still render it when called later (e.g. --help).
let cachedScriptTagline: string | undefined;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitGraphemes(value: string): string[] {
  if (!graphemeSegmenter) {
    return Array.from(value);
  }
  try {
    return Array.from(graphemeSegmenter.segment(value), (seg) => seg.segment);
  } catch {
    return Array.from(value);
  }
}

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V") || hasRootVersionAlias(argv);

// Matches any -h/--help flag in argv (subcommand-scoped or root) and the help subcommand.
// Uses the same simple scan as hasHelpOrVersion elsewhere in the codebase; Commander
// treats --help as a reserved flag so value-token false positives are not a concern in practice.
const hasHelpFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--help" || arg === "-h") || getPrimaryCommand(argv) === "help";

function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off" || value === "script") {
    return value;
  }
  return undefined;
}

function resolveTaglineMode(options: BannerOptions): TaglineMode | undefined {
  const explicit = parseTaglineMode(options.mode);
  if (explicit) {
    return explicit;
  }
  return readCliBannerTaglineMode(options.env);
}

function resolveTaglineScriptPath(options: BannerOptions): string | undefined {
  if (options.scriptPath) {
    return options.scriptPath;
  }
  try {
    return loadConfig().cli?.banner?.taglineScriptFile;
  } catch {
    return undefined;
  }
}

export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const commit =
    options.commit ?? resolveCommitHash({ env: options.env, moduleUrl: import.meta.url });
  const commitLabel = commit ?? "unknown";
  const resolvedMode = resolveTaglineMode(options);
  const resolvedTagline =
    resolvedMode === "script" && options.resolvedTagline === undefined
      ? cachedScriptTagline
      : options.resolvedTagline;
  const tagline = pickTagline({ ...options, mode: resolvedMode, resolvedTagline });
  const rich = options.richTty ?? isRich();
  const title = "🦞 OpenClaw";
  const prefix = "🦞 ";
  const columns = options.columns ?? process.stdout.columns ?? 120;
  const plainBaseLine = `${title} ${version} (${commitLabel})`;
  const plainFullLine = tagline ? `${plainBaseLine} — ${tagline}` : plainBaseLine;
  const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
  if (rich) {
    if (fitsOnOneLine) {
      if (!tagline) {
        return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
      }
      return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
        `(${commitLabel})`,
      )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
    }
    const line1 = `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )}`;
    if (!tagline) {
      return line1;
    }
    const line2 = `${" ".repeat(prefix.length)}${theme.accentDim(tagline)}`;
    return `${line1}\n${line2}`;
  }
  if (fitsOnOneLine) {
    return plainFullLine;
  }
  const line1 = plainBaseLine;
  if (!tagline) {
    return line1;
  }
  const line2 = `${" ".repeat(prefix.length)}${tagline}`;
  return `${line1}\n${line2}`;
}

const LOBSTER_ASCII = [
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  "██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
  "██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
  "██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "                  🦞 OPENCLAW 🦞                    ",
  " ",
];

export function formatCliBannerArt(options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();
  if (!rich) {
    return LOBSTER_ASCII.join("\n");
  }

  const colorChar = (ch: string) => {
    if (ch === "█") {
      return theme.accentBright(ch);
    }
    if (ch === "░") {
      return theme.accentDim(ch);
    }
    if (ch === "▀") {
      return theme.accent(ch);
    }
    return theme.muted(ch);
  };

  const colored = LOBSTER_ASCII.map((line) => {
    if (line.includes("OPENCLAW")) {
      return (
        theme.muted("              ") +
        theme.accent("🦞") +
        theme.info(" OPENCLAW ") +
        theme.accent("🦞")
      );
    }
    return splitGraphemes(line).map(colorChar).join("");
  });

  return colored.join("\n");
}

export async function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  // Skip script resolution (and banner emission) for machine-readable output and --version,
  // where no banner will ever be shown. This avoids running user JS unnecessarily.
  if (hasJsonFlag(argv) || hasVersionFlag(argv)) {
    return;
  }
  const isTTY = process.stdout.isTTY;
  const resolvedMode = resolveTaglineMode(options);
  let resolvedOptions = { ...options, mode: resolvedMode };
  // Prime the script tagline cache when the banner will be rendered: either on a TTY
  // (for normal emission) or when --help is present (for formatCliBannerLine in help output),
  // but not for plain piped/non-interactive invocations that show no banner at all.
  if (resolvedMode === "script" && cachedScriptTagline === undefined && (isTTY || hasHelpFlag(argv))) {
    const scriptPath = resolveTaglineScriptPath(options);
    if (scriptPath) {
      try {
        cachedScriptTagline = await resolveScriptTagline(scriptPath);
      } catch {
        // Fall back to empty tagline if script fails.
        cachedScriptTagline = "";
      }
    }
  }
  if (resolvedMode === "script") {
    resolvedOptions = { ...resolvedOptions, resolvedTagline: cachedScriptTagline };
  }
  if (!isTTY) {
    return;
  }
  const line = formatCliBannerLine(version, resolvedOptions);
  process.stdout.write(`\n${line}\n\n`);
  bannerEmitted = true;
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}

/** Reset module-level banner state. For use in tests only. */
export function _resetBannerStateForTest(): void {
  bannerEmitted = false;
  cachedScriptTagline = undefined;
}
