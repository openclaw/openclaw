import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeHomeDirValue } from "@openclaw/normalization-core/home-dir";
import { resolveConfigDir } from "./infra/config-dir.js";
import { resolveEffectiveHomeDir, resolveUserPath } from "./infra/home-dir.js";
import { shortenPathWithHome } from "./infra/home-display.js";
import "./infra/plain-object.js";
import { escapeRegExp as escapeRegExpValue } from "./shared/regexp.js";
export { isPlainObject } from "./infra/plain-object.js";
export { escapeRegExp } from "./shared/regexp.js";
export { sleep } from "./utils/sleep.js";
export { pathExists } from "@openclaw/fs-safe/advanced";
export { isRecord } from "@openclaw/normalization-core/record-coerce";
export { resolveConfigDir, resolveUserPath };

/** Creates a directory tree if it does not already exist. */
export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Clamps a number to an inclusive min/max range. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Floors a number before clamping it to an inclusive min/max range. */
export function clampInt(value: number, min: number, max: number): number {
  return clampNumber(Math.floor(value), min, max);
}

/** Alias for clampNumber (shorter, more common name) */
export const clamp = clampNumber;

/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON parsing helper lets callers ascribe the expected payload type.
export function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Normalizes phone-like input into the loose E.164 shape used by channel helpers. */
export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^[a-z][a-z0-9-]*:/i, "").trim();
  const digits = withoutPrefix.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

// Surrogate-safe slicing helpers live in a node-free leaf module so browser/UI
// bundles can import them without pulling in filesystem code. Re-exported here
// to preserve the historical `utils.ts` import surface.
export { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Resolves the effective OpenClaw home directory, if one can be determined. */
export function resolveHomeDir(): string | undefined {
  return resolveEffectiveHomeDir(process.env, os.homedir);
}

// Stack traces print ESM paths as file:// URLs, so the URL scheme also starts a path.
const HOME_TEXT_START = String.raw`(?<=^|[\s"'\x60(\[{<=:;]|file://)`;
const HOME_TEXT_DELIMITER = String.raw`[\s"'\x60)\]}>]`;

// A PATH-style list continues with another absolute path, home prefix, or drive letter.
const HOME_TEXT_LIST_NEXT = String.raw`[:;](?=[/\\~$]|[A-Za-z]:)`;

function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = normalizeHomeDirValue(process.env.OPENCLAW_HOME);
  if (explicitHome) {
    return { home, prefix: "$OPENCLAW_HOME" };
  }
  return { home, prefix: "~" };
}

/** Replaces the leading home directory in a path with `~` or `$OPENCLAW_HOME`. */
export function shortenHomePath(input: string): string {
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  return shortenPathWithHome(input, display);
}

/** Replaces effective-home path occurrences inside a diagnostic string. */
export function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  // A filesystem-root home such as "/" would turn every path separator into the prefix.
  if (!display || path.parse(display.home).root === display.home) {
    return input;
  }
  // Diagnostics delimit paths with whitespace, quotes, brackets, `=`, and PATH list separators.
  // Replace the home only between those delimiters so /home/al+old, /mnt/home/al, and
  // /home/al.bak stay exact. Trailing `.`, `,`, `;`, or `:` ends the home only when a
  // delimiter, the end of the text, or the next PATH entry follows it.
  // POSIX file names may contain backslashes, so only Windows treats them as separators.
  const pathSeparator = process.platform === "win32" ? String.raw`[\\/]` : "/";
  const homePattern = new RegExp(
    `${HOME_TEXT_START}${escapeRegExpValue(display.home)}(?=$|${pathSeparator}|${HOME_TEXT_DELIMITER}|[.,;:](?:$|${HOME_TEXT_DELIMITER})|${HOME_TEXT_LIST_NEXT})`,
    process.platform === "win32" ? "giu" : "gu",
  );
  return input.replace(homePattern, display.prefix);
}

/** Shortens a path for display without changing non-home paths. */
export function displayPath(input: string): string {
  return shortenHomePath(input);
}

/** Shortens home paths embedded in arbitrary display text. */
export function displayString(input: string): string {
  return shortenHomeInString(input);
}

// Gateway startup re-pins this live binding after config/state selection converges so modules
// imported during early CLI bootstrap cannot keep using the superseded configuration root.
export let CONFIG_DIR = resolveConfigDir();

export function pinConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  CONFIG_DIR = resolveConfigDir(env);
  return CONFIG_DIR;
}
