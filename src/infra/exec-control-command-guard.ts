import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitShellArgs } from "../utils/shell-argv.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import { unwrapDispatchWrappersForResolution } from "./dispatch-wrapper-resolution.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

type CommandPayload = {
  argv: string[];
  text: string;
  workdir?: string;
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
    if (parseExecApprovalShellCommand(candidate.text)) {
      return "approve";
    }
    if (parseOpenClawChannelsLoginShellCommand(candidate.text)) {
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

const RG_OPTION_ARGS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-e",
  "-f",
  "-g",
  "-j",
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
  "--ignore-file",
  "--json-seq",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
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

const GREP_OPTION_ARGS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--group-separator",
  "--include",
  "--label",
  "--max-count",
  "--regexp",
]);

function commandPayloadKey(payload: CommandPayload): string {
  return `${payload.workdir ?? ""}\0${payload.argv.join("\0")}`;
}

function payloadFromArgv(argv: string[], workdir?: string): CommandPayload | null {
  if (argv.length === 0) {
    return null;
  }
  return {
    argv,
    text: argv.join(" "),
    ...(workdir ? { workdir } : {}),
  };
}

function pushUniquePayload(
  payloads: CommandPayload[],
  seen: Set<string>,
  payload: CommandPayload | null,
): void {
  if (!payload) {
    return;
  }
  const key = commandPayloadKey(payload);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  payloads.push(payload);
}

function payloadsFromCandidateStrings(candidates: string[], workdir?: string): CommandPayload[] {
  return normalizeStringEntries(candidates).flatMap((candidate) => {
    const argv = splitShellArgs(candidate);
    return argv
      ? [payloadFromArgv(argv, workdir)].filter((payload): payload is CommandPayload =>
          Boolean(payload),
        )
      : [];
  });
}

function isCwdChangingCommandContext(context: string): boolean {
  return context === "top-level" || context === "wrapper-payload";
}

function resolveCdWorkdir(argv: readonly string[], currentWorkdir: string): string | null {
  if (normalizeCommandBaseName(argv[0]) !== "cd") {
    return null;
  }
  const target = argv.find((token, index) => index > 0 && token !== "--" && !token.startsWith("-"));
  if (target === "-") {
    return null;
  }
  const resolved = resolveSearchTargetPath(target ?? "~", currentWorkdir);
  return resolved ? maybeRealpath(resolved) : null;
}

function subshellScopeKey(source: string, endIndex: number): string {
  const stack: number[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < Math.min(endIndex, source.length); index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      stack.push(index);
    } else if (char === ")") {
      stack.pop();
    }
  }
  return stack.join("/");
}

function createCommandPayloads(rawCommand: string, workdir?: string): Promise<CommandPayload[]> {
  return (async () => {
    const fallbackCandidates = rawCommand.split(/\r?\n/u).flatMap((line) => {
      const argv = splitShellArgs(line);
      return argv ? payloadsFromCandidateStrings(buildCommandPayloadCandidates(argv), workdir) : [];
    });
    try {
      const explanation = await explainShellCommand(rawCommand.trim());
      if (explanation.ok) {
        const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands].toSorted(
          (a, b) => a.span.startIndex - b.span.startIndex,
        );
        const parsedCandidates: CommandPayload[] = [];
        const seen = new Set<string>();
        const currentWorkdirBySubshellScope = new Map<string, string | undefined>([["", workdir]]);
        for (const step of commands) {
          const subshellScope = subshellScopeKey(rawCommand, step.span.startIndex);
          const stepWorkdir = currentWorkdirBySubshellScope.get(subshellScope) ?? workdir;
          pushUniquePayload(parsedCandidates, seen, payloadFromArgv(step.argv, stepWorkdir));
          for (const payload of payloadsFromCandidateStrings(
            buildCommandPayloadCandidates(step.argv),
            stepWorkdir,
          )) {
            pushUniquePayload(parsedCandidates, seen, payload);
          }
          if (stepWorkdir && isCwdChangingCommandContext(step.context)) {
            currentWorkdirBySubshellScope.set(
              subshellScope,
              resolveCdWorkdir(step.argv, stepWorkdir) ?? stepWorkdir,
            );
          }
        }
        return parsedCandidates.length > 0 ? parsedCandidates : fallbackCandidates;
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

function collectNonOptionArgs(
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0] ?? token;
      if (!token.includes("=") && optionsWithValues.has(option)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.slice(0, 2);
      if (optionsWithValues.has(option) && token.length === 2) {
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function hasGrepRecursiveFlag(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--recursive" || arg === "-r" || arg === "-R") {
      return true;
    }
    if (arg === "-d" || arg === "--directories") {
      const value = args[index + 1];
      if (value === "recurse") {
        return true;
      }
      index += 1;
      continue;
    }
    if (arg === "--directories=recurse") {
      return true;
    }
    if (/^-[^-].*[rR]/u.test(arg)) {
      return true;
    }
  }
  return false;
}

function hasSearchPatternOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
      return true;
    }
    return (
      arg.startsWith("-e") ||
      arg.startsWith("-f") ||
      arg.startsWith("--regexp=") ||
      arg.startsWith("--file=")
    );
  });
}

function resolveRgSearchPaths(args: readonly string[]): string[] {
  if (args.includes("--help") || args.includes("--version")) {
    return [];
  }
  const nonOptionArgs = collectNonOptionArgs(args, RG_OPTION_ARGS_WITH_VALUES);
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
  const nonOptionArgs = collectNonOptionArgs(args, GREP_OPTION_ARGS_WITH_VALUES);
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
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "-H" || arg === "-L" || arg === "-P" || /^-O(?:\d+)?$/u.test(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-D") {
      index += 2;
      continue;
    }
    break;
  }
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
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
  const expanded = expandHomePrefix(expandShellHomePrefix(searchPath));
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workdir, expanded));
}

function expandShellHomePrefix(input: string): string {
  const shellHome = process.env.HOME || os.homedir();
  return shellHome
    ? input.replace(/^\$HOME(?=$|[\\/])/u, shellHome).replace(/^\$\{HOME\}(?=$|[\\/])/u, shellHome)
    : input;
}

function maybeRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function protectedRootForResolvedPath(resolved: string): string | null {
  const normalizedResolved = path.resolve(resolved);
  if (normalizedResolved === path.parse(normalizedResolved).root) {
    return normalizedResolved;
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
  const matchedHomeRoot = homeProtectedRoots.find((root) => {
    const normalizedRoot = path.resolve(root);
    return (
      normalizedResolved === normalizedRoot || normalizedResolved === maybeRealpath(normalizedRoot)
    );
  });
  if (matchedHomeRoot) {
    return matchedHomeRoot;
  }
  const matchedRunnerWorkRoot = homeDirs
    .map((homeDir) => {
      const relative = path.relative(homeDir, normalizedResolved).split(path.sep).filter(Boolean);
      return relative[0] === "work" && relative.length <= 2 ? normalizedResolved : null;
    })
    .find((root) => root !== null);
  if (matchedRunnerWorkRoot) {
    return matchedRunnerWorkRoot;
  }
  const segments = normalizedResolved.split(path.sep).filter(Boolean);
  if (segments[0] === "Volumes" && segments.length <= 3) {
    return path.sep + path.join(...segments);
  }
  if (segments.length === 1 && ["workspace", "workspaces"].includes(segments[0] ?? "")) {
    return normalizedResolved;
  }
  if (segments.at(-1) === "repos" && segments.length <= 3) {
    return normalizedResolved;
  }
  return null;
}

function protectedRootForPath(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  return (
    protectedRootForResolvedPath(resolved) ??
    protectedRootForResolvedPath(maybeRealpath(resolved) ?? resolved)
  );
}

function globBaseSearchPath(searchPath: string): string | null {
  const globIndex = searchPath.search(/[*?[]/u);
  if (globIndex === -1) {
    return null;
  }
  const prefix = searchPath.slice(0, globIndex);
  if (!prefix || prefix.endsWith("/") || prefix.endsWith("\\")) {
    return prefix ? prefix.replace(/[\\/]+$/u, "") || "." : ".";
  }
  return path.dirname(prefix);
}

function protectedRootForSearchPath(searchPath: string, workdir: string): string | null {
  const targetPath = resolveSearchTargetPath(searchPath, workdir);
  if (!targetPath) {
    return null;
  }
  const directRoot = protectedRootForPath(targetPath);
  if (directRoot) {
    return directRoot;
  }
  const globBase = globBaseSearchPath(searchPath);
  if (!globBase) {
    return null;
  }
  const globBasePath = resolveSearchTargetPath(globBase, workdir);
  return globBasePath ? protectedRootForPath(globBasePath) : null;
}

function detectBroadSearchArgv(params: {
  argv: string[];
  workdir: string;
}): UnsafeExecBroadSearchShellCommand | null {
  const argv = unwrapDispatchWrappersForResolution(stripLeadingEnvAssignments(params.argv));
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
    const protectedRoot = protectedRootForSearchPath(searchPath, params.workdir);
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
  const payloads = await createCommandPayloads(params.command, params.workdir);
  for (const payload of payloads) {
    const hit = detectBroadSearchArgv({
      argv: payload.argv,
      workdir: payload.workdir ?? params.workdir,
    });
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
