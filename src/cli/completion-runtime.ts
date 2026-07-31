// Shell completion runtime: cache paths, profile installation, and shell detection.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { pathExists } from "../utils.js";

export const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";

/** Narrows an arbitrary shell label to a completion shell supported by installer logic. */
export function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

function resolveShellBasename(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const platformBasename =
    platform === "win32" ? path.win32.basename(shellPath) : path.basename(shellPath);
  const winBasename = path.win32.basename(shellPath);
  const basename = winBasename.length < platformBasename.length ? winBasename : platformBasename;
  return normalizeLowercaseStringOrEmpty(basename.replace(/\.(?:exe|cmd|bat)$/i, ""));
}

/** Resolves the active shell from environment paths, defaulting to zsh for unknown shells. */
export function resolveShellFromEnv(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellPath = normalizeOptionalString(env.SHELL) ?? "";
  const shellName = shellPath ? resolveShellBasename(shellPath) : "";
  if (shellName === "zsh") {
    return "zsh";
  }
  if (shellName === "bash") {
    return "bash";
  }
  if (shellName === "fish") {
    return "fish";
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return "powershell";
  }
  return "zsh";
}

function sanitizeCompletionBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "openclaw";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resolveCompletionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "completions");
}

function completionShellExtension(shell: CompletionShell): string {
  return shell === "powershell" ? "ps1" : shell;
}

/** Returns the per-shell cached completion script path for a sanitized CLI binary name. */
export function resolveCompletionCachePath(shell: CompletionShell, binName: string): string {
  const basename = sanitizeCompletionBasename(binName);
  return path.join(resolveCompletionCacheDir(), `${basename}.${completionShellExtension(shell)}`);
}

/** Check if the completion cache file exists for the given shell. */
export async function completionCacheExists(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const cachePath = resolveCompletionCachePath(shell, binName);
  return pathExists(cachePath);
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeDoubleQuotedShellString(shell: CompletionShell, value: string): string {
  // Backticks substitute commands in POSIX shells but are literal inside Fish double quotes.
  return value.replace(shell === "fish" ? /[\\$"]/g : /[\\$"`]/g, "\\$&");
}

function quoteCompletionShellPath(shell: CompletionShell, value: string): string {
  if (shell !== "fish" && value.includes("!")) {
    // Interactive Bash and Zsh expand history even inside double quotes.
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  return `"${escapeDoubleQuotedShellString(shell, value)}"`;
}

function formatCompletionSourceLine(shell: CompletionShell, cachePath: string): string {
  if (shell === "powershell") {
    return `. '${escapePowerShellSingleQuotedString(cachePath)}'`;
  }
  const quotedCachePath = quoteCompletionShellPath(shell, cachePath);
  if (shell === "fish") {
    return `test -f ${quotedCachePath}; and source ${quotedCachePath}`;
  }
  return `[ -f ${quotedCachePath} ] && source ${quotedCachePath}`;
}

/** Formats the command users can run to reload the shell profile after installation. */
export function formatCompletionReloadCommand(shell: CompletionShell, profilePath: string): string {
  if (shell === "powershell") {
    return `. '${escapePowerShellSingleQuotedString(profilePath)}'`;
  }
  if (/^[A-Za-z0-9_./~+-]+$/.test(profilePath)) {
    return `source ${profilePath}`;
  }
  if (profilePath.startsWith("~/")) {
    if (shell !== "fish" && profilePath.includes("!")) {
      return `source "$HOME"/${quoteCompletionShellPath(shell, profilePath.slice(2))}`;
    }
    return `source "$HOME/${escapeDoubleQuotedShellString(shell, profilePath.slice(2))}"`;
  }
  return `source ${quoteCompletionShellPath(shell, profilePath)}`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# OpenClaw Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string | null): boolean {
  if (isSlowDynamicCompletionLine(line, binName)) {
    return true;
  }
  if (!cachePath) {
    return false;
  }
  const trimmed = line.trim();
  return (
    trimmed === `source "${cachePath}"` ||
    COMPLETION_SHELLS.some((shell) => trimmed === formatCompletionSourceLine(shell, cachePath))
  );
}

function isPreviousCompletionSourceLine(line: string, currentCachePath: string | null): boolean {
  if (!currentCachePath) {
    return false;
  }
  const trimmed = line.trim();
  const guarded =
    /^(?:\[\s+-f|test\s+-f)\s+"([^"]+)"\s*(?:\]\s*&&|;\s*and)\s+source\s+"([^"]+)"$/u.exec(trimmed);
  const direct = /^source\s+"([^"]+)"$/u.exec(trimmed);
  const powershell = /^\.\s+'((?:[^']|'')+)'$/u.exec(trimmed);
  let sourcePath: string | undefined;
  if (guarded && guarded[1] === guarded[2]) {
    sourcePath = guarded[1];
  } else if (direct) {
    sourcePath = direct[1];
  } else if (powershell) {
    sourcePath = powershell[1]?.replace(/''/g, "'");
  }
  if (!sourcePath) {
    return false;
  }
  const sourcePaths = sourcePath.includes("\\") ? path.win32 : path;
  if (sourcePaths.basename(sourcePaths.dirname(sourcePath)) !== "completions") {
    return false;
  }
  return sourcePaths.basename(sourcePath) === path.basename(currentCachePath);
}

function isOwnedCompletionInvocation(invocation: string, binName: string): boolean {
  const [command, action, ...args] = invocation.trim().split(/\s+/u);
  if (command !== binName || action !== "completion") {
    return false;
  }
  if (args.length === 0) {
    return true;
  }
  if (args.length === 1) {
    const argument = args[0] ?? "";
    const shell = argument.startsWith("--shell=")
      ? argument.slice("--shell=".length)
      : argument.startsWith("-s") && argument.length > 2
        ? argument.slice(2).replace(/^=/u, "")
        : argument;
    return isCompletionShell(shell);
  }
  return (
    args.length === 2 &&
    (args[0] === "--shell" || args[0] === "-s") &&
    isCompletionShell(args[1] ?? "")
  );
}

/** Check if a line uses an owned slow dynamic completion pattern (source <(...)). */
function isSlowDynamicCompletionLine(line: string, binName: string): boolean {
  const trimmed = line.trim();
  const dynamicMarker = `<(${binName} completion`;
  const markerIndex = trimmed.indexOf(dynamicMarker);
  if (markerIndex >= 0) {
    const expression = trimmed.slice(markerIndex);
    // Compound profile statements are user-owned; deleting the entire line loses their commands.
    return (
      /^(?:(?:\[\s+-f\s+[^\]]+\]\s*&&\s*)?(?:source|\.))\s*$/u.test(
        trimmed.slice(0, markerIndex).trimEnd(),
      ) &&
      expression.endsWith(")") &&
      isOwnedCompletionInvocation(expression.slice(2, -1), binName)
    );
  }
  const invocationIndex = trimmed.indexOf(`${binName} completion`);
  if (invocationIndex < 0) {
    return false;
  }
  const invocationPrefix = trimmed.slice(0, invocationIndex).trimEnd();
  const evalPrefix = /^eval\s+(["']?)\$\($/u.exec(invocationPrefix);
  if (evalPrefix) {
    const invocation = trimmed.slice(invocationIndex);
    const closing = `)${evalPrefix[1] ?? ""}`;
    return (
      invocation.endsWith(closing) &&
      isOwnedCompletionInvocation(invocation.slice(0, -closing.length), binName)
    );
  }
  if (invocationIndex !== 0 || /[;&]/u.test(trimmed)) {
    return false;
  }
  const pipeline = trimmed.split("|").map((stage) => stage.trim());
  const terminal = pipeline.at(-1) ?? "";
  // Only the documented optional Out-String stage is owned by completion migration.
  return (
    isOwnedCompletionInvocation(pipeline[0] ?? "", binName) &&
    /^(?:source|Invoke-Expression|iex)$/iu.test(terminal) &&
    (pipeline.length === 2 || (pipeline.length === 3 && /^Out-String$/iu.test(pipeline[1] ?? "")))
  );
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string | null,
  sourceLine: string,
): { next: string; changed: boolean; hadExisting: boolean } {
  // Remove both cached and old dynamic blocks so installs converge to one fast source line.
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      // An orphaned marker owns no following user line; remove only a recognized source line.
      const following = lines[i + 1] ?? "";
      if (
        isCompletionProfileLine(following, binName, cachePath) ||
        isPreviousCompletionSourceLine(following, cachePath)
      ) {
        i += 1;
      }
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# OpenClaw Completion\n${sourceLine}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

type CompletionProfileOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: () => string;
  platform?: NodeJS.Platform;
};

function appendCompletionProfilePath(
  directory: string,
  segments: readonly string[],
  pathApi: typeof path.posix,
): string {
  const nativeDirectory = pathApi.sep === "\\" ? directory.replace(/\//g, pathApi.sep) : directory;
  const separator = nativeDirectory.endsWith(pathApi.sep) ? "" : pathApi.sep;
  // Shell startup resolves symlinks before `..`; path.join would silently change that target.
  return `${nativeDirectory}${separator}${segments.join(pathApi.sep)}`;
}

function resolveZshProfileDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  pathApi: typeof path.posix,
): string {
  const initialDirectory = Object.hasOwn(env, "ZDOTDIR") ? env.ZDOTDIR : undefined;
  const fallbackDirectory =
    initialDirectory === undefined
      ? home
      : initialDirectory === ""
        ? pathApi.parse(home).root || pathApi.sep
        : initialDirectory;
  const shellPath = normalizeOptionalString(env.SHELL);
  const zsh = shellPath && resolveShellBasename(shellPath) === "zsh" ? shellPath : "zsh";
  // Source interactive .zshenv directly so profile discovery never runs the user's .zshrc.
  const startupProbe = [
    "setopt rcs",
    '__openclaw_zdotdir="${ZDOTDIR-${HOME}}"',
    'if [[ -r "${__openclaw_zdotdir}/.zshenv" ]]; then source "${__openclaw_zdotdir}/.zshenv"; fi',
    'builtin printf "\\0%s\\0%s\\0" "${ZDOTDIR-${HOME}}" "$PWD"',
  ].join("; ");
  const result = spawnSync(zsh, ["-f", "-i", "-c", startupProbe], {
    encoding: "utf8",
    env: { ...env, HOME: home },
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return fallbackDirectory;
  }

  const end = result.stdout.lastIndexOf("\0");
  const workingDirectoryStart = result.stdout.lastIndexOf("\0", end - 1);
  const effectiveDirectoryStart = result.stdout.lastIndexOf("\0", workingDirectoryStart - 1);
  if (end < 0 || workingDirectoryStart < 0 || effectiveDirectoryStart < 0) {
    return fallbackDirectory;
  }
  const effectiveDirectory = result.stdout.slice(
    effectiveDirectoryStart + 1,
    workingDirectoryStart,
  );
  if (effectiveDirectory === "") {
    return pathApi.parse(home).root || pathApi.sep;
  }
  if (pathApi.isAbsolute(effectiveDirectory)) {
    return effectiveDirectory;
  }
  const workingDirectory = result.stdout.slice(workingDirectoryStart + 1, end);
  return workingDirectory
    ? appendCompletionProfilePath(workingDirectory, [effectiveDirectory], pathApi)
    : fallbackDirectory;
}

/** Resolves the shell startup profile path that should contain the OpenClaw completion block. */
export function resolveCompletionProfilePath(
  shell: CompletionShell,
  options: CompletionProfileOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = env.HOME || homeDir();
  if (shell === "zsh") {
    return appendCompletionProfilePath(
      resolveZshProfileDirectory(env, home, pathApi),
      [".zshrc"],
      pathApi,
    );
  }
  if (shell === "bash") {
    // Installation, status, and repairs must inspect the same real Bash profile.
    const bashrc = pathApi.join(home, ".bashrc");
    return existsSync(bashrc) ? bashrc : pathApi.join(home, ".bash_profile");
  }
  if (shell === "fish") {
    // Fish treats every nonempty XDG root literally, including whitespace and relative paths.
    const configHome = env.XDG_CONFIG_HOME || pathApi.join(home, ".config");
    return appendCompletionProfilePath(configHome, ["fish", "config.fish"], pathApi);
  }
  if (platform === "win32") {
    const shellPath = normalizeOptionalString(env.SHELL) ?? "";
    const shellName = shellPath ? resolveShellBasename(shellPath, platform) : "";
    const profileDirectory = shellName === "powershell" ? "WindowsPowerShell" : "PowerShell";
    return path.win32.join(
      env.USERPROFILE || home,
      "Documents",
      profileDirectory,
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return pathApi.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

/** Formats the actual startup profile relative to HOME without misrepresenting external roots. */
export function resolveCompletionProfileHint(
  shell: CompletionShell,
  options: CompletionProfileOptions = {},
): string {
  const profilePath = resolveCompletionProfilePath(shell, options);
  if (shell === "powershell") {
    return profilePath;
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = env.HOME || (options.homeDir ?? os.homedir)();
  if (!pathApi.isAbsolute(profilePath)) {
    const relativeProfilePath = profilePath.split(pathApi.sep).join("/");
    // Relative roots can start with tilde, options, or signs; make their filesystem meaning explicit.
    return relativeProfilePath.startsWith("./") || relativeProfilePath.startsWith("../")
      ? relativeProfilePath
      : `./${relativeProfilePath}`;
  }
  const normalizedProfilePath = profilePath.split(pathApi.sep).join("/");
  const normalizedHome = home.split(pathApi.sep).join("/");
  const homePrefix = normalizedHome.endsWith("/") ? normalizedHome : `${normalizedHome}/`;
  const comparableProfile =
    platform === "win32" ? normalizedProfilePath.toLowerCase() : normalizedProfilePath;
  const comparableHome = platform === "win32" ? homePrefix.toLowerCase() : homePrefix;
  // Prefix matching keeps symlink-sensitive `..` in the executable startup hint.
  return comparableProfile.startsWith(comparableHome)
    ? `~/${normalizedProfilePath.slice(homePrefix.length)}`
    : normalizedProfilePath;
}

/** Returns whether a shell profile already contains an OpenClaw completion block or source line. */
export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const cachePath = resolveCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");
  // A marker does not install completion; retain missing-cache source lines for doctor repair.
  return lines.some((line) => isCompletionProfileLine(line, binName, cachePath));
}

/**
 * Check if the profile uses the slow dynamic completion pattern.
 * Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
 */
export async function usesSlowDynamicCompletion(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) {
      return true;
    }
  }
  return false;
}

export async function installCompletion(shell: string, yes: boolean, binName = "openclaw") {
  const isShellSupported = isCompletionShell(shell);
  if (!isShellSupported) {
    throw new Error(`Automated installation not supported for ${shell} yet.`);
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const cacheExists = await pathExists(cachePath);
  if (!cacheExists) {
    throw new Error(
      `Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`,
    );
  }

  let profilePath: string;
  let sourceLine: string;
  switch (shell) {
    case "zsh":
      profilePath = resolveCompletionProfilePath("zsh");
      sourceLine = formatCompletionSourceLine("zsh", cachePath);
      break;
    case "bash":
      profilePath = resolveCompletionProfilePath("bash");
      sourceLine = formatCompletionSourceLine("bash", cachePath);
      break;
    case "fish":
      profilePath = resolveCompletionProfilePath("fish");
      sourceLine = formatCompletionSourceLine("fish", cachePath);
      break;
    case "powershell":
      profilePath = resolveCompletionProfilePath("powershell");
      sourceLine = formatCompletionSourceLine("powershell", cachePath);
      break;
  }

  try {
    try {
      await fs.access(profilePath);
    } catch {
      if (!yes) {
        console.warn(`Profile not found at ${profilePath}. Created a new one.`);
      }
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, "", "utf-8");
    }

    const content = await fs.readFile(profilePath, "utf-8");
    const update = updateCompletionProfile(content, binName, cachePath, sourceLine);
    if (!update.changed) {
      if (!yes) {
        console.log(`Completion already installed in ${profilePath}`);
      }
      return;
    }

    if (!yes) {
      const action = update.hadExisting ? "Updating" : "Installing";
      console.log(`${action} completion in ${profilePath}...`);
    }

    await fs.writeFile(profilePath, update.next, "utf-8");
    if (!yes) {
      console.log(
        `Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, profilePath)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install completion: ${message}`, { cause: err });
  }
}
