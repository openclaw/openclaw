import gradient from "gradient-string";
import { resolveCommitHash } from "../infra/git-commit.js";
import { visibleWidth } from "../terminal/ansi.js";
import { isRich, theme } from "../terminal/theme.js";
import { pickTagline, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  columns?: number;
  richTty?: boolean;
};

let bannerEmitted = false;

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V" || arg === "-v");

// ---------------------------------------------------------------------------
// IRONCLAW ASCII art (figlet "ANSI Shadow" font, baked at build time)
// ---------------------------------------------------------------------------
const IRONCLAW_ASCII = [
  " ██╗██████╗  ██████╗ ███╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗",
  " ██║██╔══██╗██╔═══██╗████╗  ██║██╔════╝██║     ██╔══██╗██║    ██║",
  " ██║██████╔╝██║   ██║██╔██╗ ██║██║     ██║     ███████║██║ █╗ ██║",
  " ██║██╔══██╗██║   ██║██║╚██╗██║██║     ██║     ██╔══██║██║███╗██║",
  " ██║██║  ██║╚██████╔╝██║ ╚████║╚██████╗███████╗██║  ██║╚███╔███╔╝",
  " ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
];

// ---------------------------------------------------------------------------
// Iron-metallic gradient colors (dark iron → bright silver → dark iron)
// ---------------------------------------------------------------------------
const IRON_GRADIENT_COLORS = [
  "#374151", // dark iron
  "#4B5563",
  "#6B7280", // medium iron
  "#9CA3AF", // steel
  "#D1D5DB", // bright silver
  "#F3F4F6", // near-white highlight
  "#D1D5DB",
  "#9CA3AF",
  "#6B7280",
  "#4B5563",
];

// ---------------------------------------------------------------------------
// Gradient animation helpers
// ---------------------------------------------------------------------------

function rotateArray<T>(arr: T[], offset: number): T[] {
  const n = arr.length;
  const o = ((offset % n) + n) % n;
  return [...arr.slice(o), ...arr.slice(0, o)];
}

function renderGradientFrame(lines: string[], frame: number): string {
  const colors = rotateArray(IRON_GRADIENT_COLORS, frame);
  return gradient(colors).multiline(lines.join("\n"));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Play the iron shimmer animation: a bright highlight sweeps across the
 * ASCII art like light glinting off polished metal. Runs for ~2.5 seconds
 * at 12 fps, completing 3 full gradient cycles.
 */
async function animateIronBanner(): Promise<void> {
  const lineCount = IRONCLAW_ASCII.length;
  const fps = 12;
  const totalFrames = IRON_GRADIENT_COLORS.length * 3; // 3 full shimmer sweeps
  const frameMs = Math.round(1000 / fps);

  // Print the first frame to claim vertical space
  process.stdout.write(renderGradientFrame(IRONCLAW_ASCII, 0) + "\n");

  for (let frame = 1; frame < totalFrames; frame++) {
    await sleep(frameMs);
    // Move cursor up to overwrite the previous frame
    process.stdout.write(`\x1b[${lineCount}A\r`);
    process.stdout.write(renderGradientFrame(IRONCLAW_ASCII, frame) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Static (non-animated) banner rendering
// ---------------------------------------------------------------------------

export function formatCliBannerArt(options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();
  if (!rich) {
    return IRONCLAW_ASCII.join("\n");
  }
  return renderGradientFrame(IRONCLAW_ASCII, 0);
}

// ---------------------------------------------------------------------------
// One-line version + tagline (prints below the ASCII art)
// ---------------------------------------------------------------------------

export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const commit = options.commit ?? resolveCommitHash({ env: options.env });
  const commitLabel = commit ?? "unknown";
  const tagline = pickTagline(options);
  const rich = options.richTty ?? isRich();
  const title = "IRONCLAW";
  const prefix = "  ";
  const columns = options.columns ?? process.stdout.columns ?? 120;
  const plainFullLine = `${prefix}${title} ${version} (${commitLabel}) — ${tagline}`;
  const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
  if (rich) {
    if (fitsOnOneLine) {
      return `${prefix}${theme.heading(title)} ${theme.info(version)} ${theme.muted(
        `(${commitLabel})`,
      )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
    }
    const line1 = `${prefix}${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )}`;
    const line2 = `${prefix}${theme.accentDim(tagline)}`;
    return `${line1}\n${line2}`;
  }
  if (fitsOnOneLine) {
    return plainFullLine;
  }
  const line1 = `${prefix}${title} ${version} (${commitLabel})`;
  const line2 = `${prefix}${tagline}`;
  return `${line1}\n${line2}`;
}

// ---------------------------------------------------------------------------
// Emit the full banner (animated ASCII art + version line)
// ---------------------------------------------------------------------------

export async function emitCliBanner(version: string, options: BannerOptions = {}) {
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

  bannerEmitted = true;
  const rich = options.richTty ?? isRich();

  process.stdout.write("\n");

  if (rich) {
    // Animated iron shimmer
    await animateIronBanner();
  } else {
    // Plain ASCII fallback
    process.stdout.write(IRONCLAW_ASCII.join("\n") + "\n");
  }

  const line = formatCliBannerLine(version, options);
  process.stdout.write(`${line}\n\n`);
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
