import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const TRUSTED_DIAGNOSTIC_BINS = new Set([
  "arch",
  "date",
  "df",
  "du",
  "hostname",
  "id",
  "ls",
  "lsof",
  "node",
  "openclaw",
  "ps",
  "pwd",
  "sw_vers",
  "true",
  "uname",
  "uptime",
  "which",
  "whoami",
]);

const TRUSTED_GIT_SUBCOMMANDS = new Set([
  "branch",
  "config",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
]);

const TRUSTED_WORKTREE_SUBCOMMANDS = new Set(["list"]);

const TRUSTED_PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

const TRUSTED_SCRIPT_RE = /(?:^|:|[-_])(build|check|lint|test|tsgo|typecheck|types)(?:$|:|[-_])/u;

const TRUSTED_GH_PR_COMMANDS = new Set(["checks", "status", "view", "list"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const DENIED_TOKENS = new Set([
  "--global",
  "--replace-all",
  "--unset",
  "--unset-all",
  "--add",
  "--rename-section",
  "--remove-section",
]);

function executableName(argv0: string | undefined): string | null {
  const raw = argv0?.trim();
  if (!raw) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(raw.split(/[\\/]/u).pop() ?? raw);
}

function hasDeniedToken(argv: readonly string[]): boolean {
  return argv.some((arg) => DENIED_TOKENS.has(normalizeLowercaseStringOrEmpty(arg)));
}

function isGitReadOnly(argv: readonly string[]): boolean {
  if (argv.length < 2 || hasDeniedToken(argv)) {
    return false;
  }
  let idx = 1;
  while (idx < argv.length) {
    const arg = argv[idx] ?? "";
    if (arg === "-C" || arg === "-c") {
      idx += 2;
      continue;
    }
    if (arg === "--no-pager" || arg === "--paginate") {
      idx += 1;
      continue;
    }
    break;
  }
  const subcommand = normalizeLowercaseStringOrEmpty(argv[idx] ?? "");
  if (subcommand === "worktree") {
    return TRUSTED_WORKTREE_SUBCOMMANDS.has(normalizeLowercaseStringOrEmpty(argv[idx + 1] ?? ""));
  }
  return TRUSTED_GIT_SUBCOMMANDS.has(subcommand);
}

function trustedPackageManagerScriptName(argv: readonly string[]): string | null {
  const bin = executableName(argv[0]);
  if (!bin || !TRUSTED_PACKAGE_MANAGERS.has(bin)) {
    return null;
  }
  const first = normalizeLowercaseStringOrEmpty(argv[1] ?? "");
  if (!first) {
    return null;
  }
  if (bin === "npm" && first === "run") {
    return argv[2]?.trim() || null;
  }
  if (bin === "yarn" && first === "run") {
    return argv[2]?.trim() || null;
  }
  if (bin === "bun" && first === "run") {
    return argv[2]?.trim() || null;
  }
  if (bin === "pnpm" && first === "run") {
    return argv[2]?.trim() || null;
  }
  return argv[1]?.trim() || null;
}

function isTrustedPackageManagerRead(argv: readonly string[]): boolean {
  const bin = executableName(argv[0]);
  if (!bin || !TRUSTED_PACKAGE_MANAGERS.has(bin)) {
    return false;
  }
  const script = trustedPackageManagerScriptName(argv);
  if (!script || !TRUSTED_SCRIPT_RE.test(normalizeLowercaseStringOrEmpty(script))) {
    return false;
  }
  const lowerArgs = argv.slice(1).map((arg) => normalizeLowercaseStringOrEmpty(arg));
  return !lowerArgs.some(
    (arg) =>
      arg === "install" ||
      arg === "add" ||
      arg === "remove" ||
      arg === "publish" ||
      arg === "deploy" ||
      arg === "version" ||
      arg === "audit" ||
      arg.startsWith("--global") ||
      arg === "-g",
  );
}

function extractCurlUrl(argv: readonly string[]): string | null {
  let method = "get";
  for (let idx = 1; idx < argv.length; idx += 1) {
    const arg = argv[idx] ?? "";
    const lower = normalizeLowercaseStringOrEmpty(arg);
    if (lower === "-x" || lower === "--request") {
      method = normalizeLowercaseStringOrEmpty(argv[idx + 1] ?? "");
      idx += 1;
      continue;
    }
    if (lower.startsWith("-x") && lower.length > 2) {
      method = lower.slice(2);
      continue;
    }
    if (lower === "-d" || lower === "--data" || lower.startsWith("--data-")) {
      return null;
    }
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      return method === "get" ? arg : null;
    }
  }
  return null;
}

function extractWgetUrl(argv: readonly string[]): string | null {
  for (let idx = 1; idx < argv.length; idx += 1) {
    const arg = argv[idx] ?? "";
    const lower = normalizeLowercaseStringOrEmpty(arg);
    if (lower === "--post-data" || lower === "--post-file" || lower.startsWith("--method=")) {
      return null;
    }
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      return arg;
    }
  }
  return null;
}

function isLocalHealthGetUrl(rawUrl: string | null): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
      return false;
    }
    return /(?:^|\/)(health|healthz|ready|readyz|live|livez|status|ping)(?:$|[/?#])/iu.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function isTrustedLocalHealthGet(argv: readonly string[]): boolean {
  const bin = executableName(argv[0]);
  if (bin === "curl") {
    return isLocalHealthGetUrl(extractCurlUrl(argv));
  }
  if (bin === "wget") {
    return isLocalHealthGetUrl(extractWgetUrl(argv));
  }
  return false;
}

function isTrustedGhRead(argv: readonly string[]): boolean {
  if (argv.length < 3) {
    return false;
  }
  let idx = 1;
  while (idx < argv.length && (argv[idx] === "--repo" || argv[idx] === "-R")) {
    idx += 2;
  }
  const surface = normalizeLowercaseStringOrEmpty(argv[idx] ?? "");
  const command = normalizeLowercaseStringOrEmpty(argv[idx + 1] ?? "");
  if (surface !== "pr" || !TRUSTED_GH_PR_COMMANDS.has(command)) {
    return false;
  }
  return !argv.some((arg) => {
    const lower = normalizeLowercaseStringOrEmpty(arg);
    return lower === "--comment" || lower === "--body" || lower === "--body-file";
  });
}

export function isTrustedOperatorAllowedArgv(argv: readonly string[]): boolean {
  const bin = executableName(argv[0]);
  if (!bin) {
    return false;
  }
  if (bin === "git") {
    return isGitReadOnly(argv);
  }
  if (bin === "gh") {
    return isTrustedGhRead(argv);
  }
  if (isTrustedPackageManagerRead(argv)) {
    return true;
  }
  if (isTrustedLocalHealthGet(argv)) {
    return true;
  }
  if (TRUSTED_DIAGNOSTIC_BINS.has(bin)) {
    return !hasDeniedToken(argv);
  }
  return false;
}
