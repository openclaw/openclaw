import { expectDefined } from "@openclaw/normalization-core";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import {
  decorativeEmoji,
  decorativePrefix,
  stripDecorativeEmojiForTerminal,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { isLobsterDay, lobsterDayHash } from "../shared/lobster-day.js";
import { hasRootVersionAlias } from "./argv.js";
import { pickTagline, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  richTty?: boolean;
};

const LOBSTER_ARTS: readonly string[] = [
  ["  (\\/)  (\\/)", "   \\_\\  /_/", "    ( o.o )", "    /|__|\\"].join("\n"),
  ["     o   o", "     )   (", "  ~~~~~~~~~~~"].join("\n"),
] as const;

let bannerEmitted = false;

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V") || hasRootVersionAlias(argv);

export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const commit =
    options.commit ?? resolveCommitHash({ env: options.env, moduleUrl: import.meta.url });
  const commitLabel = commit ?? "unknown";
  const tagline = stripDecorativeEmojiForTerminal(pickTagline(options), options);
  const rich = options.richTty ?? isRich();
  const title = decorativePrefix("🦞", "OpenClaw", options);
  const prefix = decorativeEmoji("🦞", options);
  const indent = prefix ? `${prefix} ` : "";
  const columns = process.stdout.columns ?? 120;
  const plainBaseLine = `${title} ${version} (${commitLabel})`;
  const plainFullLine = tagline ? `${plainBaseLine} — ${tagline}` : plainBaseLine;
  const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
  const baseLine = rich
    ? `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`
    : plainBaseLine;
  if (!tagline) {
    return baseLine;
  }
  const taglineText = rich ? theme.accentDim(tagline) : tagline;
  return fitsOnOneLine
    ? `${baseLine} ${rich ? theme.muted("—") : "—"} ${taglineText}`
    : `${baseLine}\n${" ".repeat(indent.length)}${taglineText}`;
}

// Rare day-seeded ASCII lobster above the banner: random-tagline mode only,
// rich terminals only, never in CI. The shared calendar keeps the UI pet in sync.
function resolveLobsterArt(options: BannerOptions): string | null {
  if (options.mode === "off" || options.mode === "default") {
    return null;
  }
  if (!(options.richTty ?? isRich())) {
    return null;
  }
  const now = new Date();
  const env = options.env ?? process.env;
  if (env.CI || env.VITEST || !isLobsterDay(now)) {
    return null;
  }
  return theme.accentDim(
    expectDefined(
      LOBSTER_ARTS[(lobsterDayHash(now) >>> 8) % LOBSTER_ARTS.length],
      "lobster arts entry at (lobster day hash(now) >>> 8) % lobster arts.length",
    ),
  );
}

export function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  if (!process.stdout.isTTY) {
    return;
  }
  if (hasJsonFlag(argv)) {
    return;
  }
  if (hasVersionFlag(argv)) {
    return;
  }
  const line = formatCliBannerLine(version, options);
  const art = resolveLobsterArt(options);
  process.stdout.write(`\n${art ? `${art}\n` : ""}${line}\n\n`);
  bannerEmitted = true;
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
