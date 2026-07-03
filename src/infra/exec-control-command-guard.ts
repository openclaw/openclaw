import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitShellArgs } from "../utils/shell-argv.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

export type UnsafeExecControlShellCommandKind = "approve" | "channel-login";
export type UnsafeExecBroadSearchShellCommand = {
  executable: "find" | "grep" | "rg";
  path: string;
  protectedRoot: string;
};

export function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1));
  return base.replace(/\.(?:cmd|exe)$/u, "");
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    normalizeCommandBaseName(argv[1]) === "openclaw"
  ) {
    return argv.slice(1);
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") &&
    normalizeCommandBaseName(argv[2]) === "openclaw"
  ) {
    return argv.slice(2);
  }
  if (commandName === "npx" || commandName === "bunx") {
    let idx = 1;
    while (idx < argv.length) {
      const token = argv[idx];
      if (token === "--") {
        idx += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      idx += 1;
      if ((token === "-p" || token === "--package") && idx < argv.length) {
        idx += 1;
      }
    }
    if (normalizeCommandBaseName(argv[idx]) === "openclaw") {
      return argv.slice(idx);
    }
  }
  return argv;
}

export function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  if (!argv) {
    return false;
  }
  const openclawArgv = stripOpenClawPackageRunner(argv);
  return (
    normalizeCommandBaseName(openclawArgv[0]) === "openclaw" &&
    (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") &&
    openclawArgv[2] === "login"
  );
}

export async function detectUnsafeExecControlShellCommand(
  command: string,
): Promise<UnsafeExecControlShellCommandKind | null> {
  const candidates = await createCommandPayloads(command);
  for (const candidate of candidates) {
    if (parseExecApprovalShellCommand(candidate)) {
      return "approve";
    }
    if (parseOpenClawChannelsLoginShellCommand(candidate)) {
      return "channel-login";
    }
  }
  return null;
}

export async function rejectUnsafeExecControlShellCommand(command: string): Promise<void> {
  const unsafeKind = await detectUnsafeExecControlShellCommand(command);
  if (unsafeKind === "approve") {
    throw new Error(
      [
        "exec cannot run /approve commands.",
        "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
      ].join(" "),
    );
  }
  if (unsafeKind === "channel-login") {
    throw new Error(
      [
        "exec cannot run interactive OpenClaw channel login commands.",
        "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
      ].join(" "),
    );
  }
}

const SEARCH_OPTION_ARGS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-e",
  "-f",
  "-g",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--context",
  "--encoding",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "--glob",
  "--glob-case-insensitive",
  "--iglob",
  "--json-seq",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--mmap",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
]);

function createCommandPayloads(rawCommand: string): Promise<string[]> {
  return (async () => {
    const fallbackCandidates = normalizeStringEntries(rawCommand.split(/\r?\n/u)).flatMap(
      (line) => {
        const argv = splitShellArgs(line);
        return argv ? buildCommandPayloadCandidates(argv) : [line];
      },
    );
    try {
      const explanation = await explainShellCommand(rawCommand.trim());
      if (explanation.ok) {
        const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands];
        return normalizeStringEntries([
          ...commands.flatMap((step) => buildCommandPayloadCandidates(step.argv)),
          ...fallbackCandidates,
        ]);
      }
    } catch {
      // Fall back to line-local shell splitting below.
    }
    return fallbackCandidates;
  })();
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) {
    index += 1;
  }
  return index > 0 ? argv.slice(index) : argv;
}

function collectNonOptionArgs(args: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0] ?? token;
      if (!token.includes("=") && SEARCH_OPTION_ARGS_WITH_VALUES.has(option)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.slice(0, 2);
      if (SEARCH_OPTION_ARGS_WITH_VALUES.has(option) && token.length === 2) {
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function hasGrepRecursiveFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "--recursive" || arg === "-r" || arg === "-R") {
      return true;
    }
    return /^-[^-].*[rR]/u.test(arg);
  });
}

function hasSearchPatternOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "-e" || arg === "--regexp") {
      return true;
    }
    return arg.startsWith("-e") || arg.startsWith("--regexp=");
  });
}

function resolveRgSearchPaths(args: readonly string[]): string[] {
  if (args.includes("--help") || args.includes("--version")) {
    return [];
  }
  const nonOptionArgs = collectNonOptionArgs(args);
  return args.includes("--files") || hasSearchPatternOption(args)
    ? nonOptionArgs.length > 0
      ? nonOptionArgs
      : ["."]
    : nonOptionArgs.length > 1
      ? nonOptionArgs.slice(1)
      : ["."];
}

function resolveGrepSearchPaths(args: readonly string[]): string[] {
  if (args.includes("--help") || args.includes("--version")) {
    return [];
  }
  const nonOptionArgs = collectNonOptionArgs(args);
  return hasSearchPatternOption(args)
    ? nonOptionArgs.length > 0
      ? nonOptionArgs
      : ["."]
    : nonOptionArgs.length > 1
      ? nonOptionArgs.slice(1)
      : ["."];
}

function resolveFindSearchPaths(args: readonly string[]): string[] {
  if (args.includes("--help") || args.includes("--version")) {
    return [];
  }
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "!" || arg === "(" || arg === ")" || arg.startsWith("-")) {
      break;
    }
    paths.push(arg);
  }
  return paths.length > 0 ? paths : ["."];
}

function resolveSearchTargetPath(searchPath: string, workdir: string): string | null {
  if (!searchPath || searchPath === "-") {
    return null;
  }
  const expanded = expandHomePrefix(searchPath);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workdir, expanded));
}

function protectedRootForPath(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  if (resolved === path.parse(resolved).root) {
    return resolved;
  }
  const homeDirs = Array.from(
    new Set([resolveRequiredHomeDir(), os.homedir()].map((home) => path.resolve(home))),
  );
  const homeProtectedRoots = homeDirs.flatMap((homeDir) => [
    homeDir,
    path.join(homeDir, ".codex"),
    path.join(homeDir, ".codex", "sessions"),
    path.join(homeDir, ".codex", "archived_sessions"),
    path.join(homeDir, ".openclaw"),
  ]);
  const matchedHomeRoot = homeProtectedRoots.find((root) => resolved === root);
  if (matchedHomeRoot) {
    return matchedHomeRoot;
  }
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments[0] === "Volumes" && segments.length <= 3) {
    return path.sep + path.join(...segments);
  }
  if (segments.at(-1) === "repos" && segments.length <= 3) {
    return resolved;
  }
  return null;
}

function detectBroadSearchArgv(params: {
  argv: string[];
  workdir: string;
}): UnsafeExecBroadSearchShellCommand | null {
  const argv = stripLeadingEnvAssignments(params.argv);
  const executable = normalizeCommandBaseName(argv[0]);
  const args = argv.slice(1);
  const paths =
    executable === "rg" || executable === "ripgrep"
      ? resolveRgSearchPaths(args)
      : executable === "grep" && hasGrepRecursiveFlag(args)
        ? resolveGrepSearchPaths(args)
        : executable === "find"
          ? resolveFindSearchPaths(args)
          : [];
  const normalizedExecutable =
    executable === "rg" || executable === "ripgrep"
      ? "rg"
      : executable === "grep" || executable === "find"
        ? executable
        : null;
  if (!normalizedExecutable || paths.length === 0) {
    return null;
  }
  for (const searchPath of paths) {
    const targetPath = resolveSearchTargetPath(searchPath, params.workdir);
    if (!targetPath) {
      continue;
    }
    const protectedRoot = protectedRootForPath(targetPath);
    if (protectedRoot) {
      return {
        executable: normalizedExecutable,
        path: searchPath,
        protectedRoot,
      };
    }
  }
  return null;
}

export async function detectUnsafeExecBroadSearchShellCommand(params: {
  command: string;
  workdir: string;
}): Promise<UnsafeExecBroadSearchShellCommand | null> {
  const payloads = await createCommandPayloads(params.command);
  for (const payload of payloads) {
    const argv = splitShellArgs(payload);
    if (!argv) {
      continue;
    }
    const hit = detectBroadSearchArgv({ argv, workdir: params.workdir });
    if (hit) {
      return hit;
    }
  }
  return null;
}

export async function rejectUnsafeExecBroadSearchShellCommand(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const hit = await detectUnsafeExecBroadSearchShellCommand(params);
  if (!hit) {
    return;
  }
  throw new Error(
    [
      `exec blocked broad recursive ${hit.executable} search over protected root ${hit.protectedRoot}.`,
      `Requested search path: ${hit.path}.`,
      "Narrow the command to a repo, task, exact file, or evidence directory; prefer indexed/search tools when available; and cap output with flags such as --max-count or a downstream head/sed range.",
    ].join(" "),
  );
}
