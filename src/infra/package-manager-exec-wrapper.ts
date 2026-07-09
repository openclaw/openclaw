// Parses package-manager exec wrappers that delegate to a concrete command.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { parseInlineOptionToken } from "./inline-option-token.js";

const NPM_EXEC_OPTIONS_WITH_VALUE = new Set([
  "--cache",
  "--loglevel",
  "--package",
  "--prefix",
  "--script-shell",
  "--userconfig",
  "--workspace",
  "-p",
  "-w",
]);

const NPM_EXEC_FLAG_OPTIONS = new Set([
  "--no",
  "--quiet",
  "--ws",
  "--workspaces",
  "--yes",
  "-q",
  "-y",
]);

const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);

// Only "x" is package exec for bun; "run"/file operands are runtime script
// invocations and "exec" is a shell-string carrier, so neither may unwrap.
const BUN_EXEC_SUBCOMMANDS = new Set(["x"]);

// Shared with node-host script-operand hardening (invoke-system-run-plan),
// which models bun as consuming a separate value for these globals.
export const BUN_OPTIONS_WITH_VALUE = new Set([
  "--backend",
  "--bunfig",
  "--conditions",
  "--config",
  "--console-depth",
  "--cwd",
  "--define",
  "--elide-lines",
  "--env-file",
  "--extension-order",
  "--filter",
  "--hot",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--install",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--loader",
  "--origin",
  "--port",
  "--preload",
  "--smol",
  "--tsconfig-override",
  "-c",
  "-e",
  "-p",
  "-r",
]);

const BUN_FLAG_OPTIONS = new Set(["--bun", "--silent", "-b"]);

export const PNPM_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--dir",
  "--filter",
  "--reporter",
  "--stream",
  "--test-pattern",
  "--workspace-concurrency",
]);

export const PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE = new Set(["-C"]);

export const PNPM_FLAG_OPTIONS = new Set([
  "--aggregate-output",
  "--color",
  "--parallel",
  "--recursive",
  "--silent",
  "--workspace-root",
  "-r",
  "-s",
  "-w",
]);

export const PNPM_DLX_OPTIONS_WITH_VALUE = new Set(["--allow-build", "--package", "-p"]);

const PNPM_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "node"]);
const PNPM_SCRIPT_RUN_SUBCOMMANDS = new Set(["restart", "run", "start", "stop", "test"]);
const PNPM_BUILTIN_NON_EXEC_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "bin",
  "config",
  "dedupe",
  "deploy",
  "help",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "outdated",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "server",
  "store",
  "unlink",
  "update",
  "view",
  "why",
]);

const YARN_OPTIONS_WITH_VALUE = new Set(["--cwd"]);
const YARN_FLAG_OPTIONS = new Set(["--immutable", "--silent", "-s"]);
const YARN_DLX_OPTIONS_WITH_VALUE = new Set(["--package", "-p"]);
const YARN_DLX_FLAG_OPTIONS = new Set(["--quiet", "-q"]);
const YARN_EXEC_SUBCOMMANDS = new Set(["exec", "dlx"]);
const YARN_BUILTIN_NON_EXEC_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "autoclean",
  "bin",
  "cache",
  "check",
  "config",
  "create",
  "dedupe",
  "generate-lock-entry",
  "global",
  "help",
  "import",
  "info",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "login",
  "logout",
  "outdated",
  "owner",
  "pack",
  "policies",
  "prune",
  "publish",
  "remove",
  "self-update",
  "tag",
  "team",
  "unlink",
  "upgrade",
  "upgrade-interactive",
  "version",
  "versions",
  "why",
  "workspace",
]);

function normalizeOptionFlag(token: string): string {
  return normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name);
}

function containsSubcommandToken(argv: string[], subcommands: ReadonlySet<string>): boolean {
  return argv.some((token) => subcommands.has(normalizeLowercaseStringOrEmpty(token)));
}

export function normalizePackageManagerExecToken(token: string): string {
  return normalizeExecutableToken(token).replace(/\.(?:c|m)?js$/i, "");
}

type PackageManagerExecInvocation =
  | { kind: "not-package-manager" }
  | { kind: "not-exec" }
  | { kind: "unsafe-exec" }
  | { kind: "unwrapped"; argv: string[] };

function firstSubcommandAfterOptions(
  argv: string[],
  params: {
    optionsWithValue: ReadonlySet<string>;
    caseSensitiveOptionsWithValue?: ReadonlySet<string>;
    flagOptions: ReadonlySet<string>;
  },
): string | null {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      return normalizeLowercaseStringOrEmpty(token);
    }
    const parsedOption = parseInlineOptionToken(token);
    if (params.caseSensitiveOptionsWithValue?.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (params.optionsWithValue.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (params.flagOptions.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapPnpmExecInvocation(argv: string[]): string[] | null {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (token === "exec") {
        if (idx + 1 >= argv.length) {
          return null;
        }
        const tail = argv.slice(idx + 1);
        const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
        const firstExecArg = normalizeOptionFlag(normalizedTail[0] ?? "");
        if (firstExecArg === "-c" || firstExecArg === "--shell-mode") {
          return null;
        }
        return normalizedTail.length > 0 ? normalizedTail : null;
      }
      if (token === "dlx") {
        return unwrapPnpmDlxInvocation(argv.slice(idx + 1));
      }
      if (token === "node") {
        const tail = argv.slice(idx + 1);
        const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
        return ["node", ...normalizedTail];
      }
      return null;
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapPnpmDlxInvocation(argv: string[]): string[] | null {
  let idx = 0;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      const tail = argv.slice(idx + 1);
      return tail.length > 0 ? tail : null;
    }
    if (!token.startsWith("-")) {
      return argv.slice(idx);
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (flag === "-c" || flag === "--shell-mode") {
      return null;
    }
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapDirectPackageExecInvocation(argv: string[]): string[] | null {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      return argv.slice(idx);
    }
    const flag = normalizeOptionFlag(token);
    if (flag === "-c" || flag === "--call") {
      return null;
    }
    if (NPM_EXEC_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (NPM_EXEC_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapNpmExecInvocation(argv: string[]): string[] | null {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (!NPM_EXEC_SUBCOMMANDS.has(token)) {
        return null;
      }
      idx += 1;
      break;
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (NPM_EXEC_OPTIONS_WITH_VALUE.has(flag) || parsedOption.name === "-C") {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (NPM_EXEC_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  if (idx >= argv.length) {
    return null;
  }
  const tail = argv.slice(idx);
  if (tail[0] === "--") {
    return tail.length > 1 ? tail.slice(1) : null;
  }
  return unwrapDirectPackageExecInvocation(["npx", ...tail]);
}

// Two dispatch models exist for a bun global option with a space-separated
// value: bun's root selector has been observed to skip dash tokens without
// consuming values, while this repo's shipped script-operand model
// (node-host invoke-system-run-plan) consumes values for the known globals in
// BUN_OPTIONS_WITH_VALUE. Unwrap only when both models select the same "x"
// token; any form whose dispatch depends on the model fails closed.
function resolveBunExecInvocation(argv: string[]): PackageManagerExecInvocation {
  const conservative = (fromIdx: number): PackageManagerExecInvocation =>
    containsSubcommandToken(argv.slice(fromIdx), BUN_EXEC_SUBCOMMANDS)
      ? { kind: "unsafe-exec" }
      : { kind: "not-exec" };

  // Selector model A: skip every dash token without consuming values.
  let selectedA: { token: string; idx: number } | null = null;
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "--") {
      // Neither model defines selection past "--"; fail closed if x follows.
      return conservative(idx + 1);
    }
    if (token.startsWith("-")) {
      continue;
    }
    selectedA = { token, idx };
    break;
  }

  // Selector model B: known valued globals consume their separate value,
  // known flags skip; an unknown dash token has unknown arity in this model,
  // so selection cannot proceed deterministically.
  let selectedB: { token: string; idx: number } | null = null;
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      return conservative(idx + 1);
    }
    if (token.startsWith("-")) {
      if (token.includes("=")) {
        idx += 1;
        continue;
      }
      const flag = normalizeOptionFlag(token);
      if (BUN_OPTIONS_WITH_VALUE.has(flag)) {
        idx += 2;
        continue;
      }
      if (BUN_FLAG_OPTIONS.has(flag)) {
        idx += 1;
        continue;
      }
      return conservative(idx + 1);
    }
    selectedB = { token, idx };
    break;
  }

  const xA = selectedA !== null && BUN_EXEC_SUBCOMMANDS.has(selectedA.token);
  const xB = selectedB !== null && BUN_EXEC_SUBCOMMANDS.has(selectedB.token);
  if (!xA && !xB) {
    return { kind: "not-exec" };
  }
  if (!xA || !xB || selectedA === null || selectedB === null || selectedA.idx !== selectedB.idx) {
    return { kind: "unsafe-exec" };
  }
  const tail = argv.slice(selectedA.idx + 1);
  if (tail[0] === "--") {
    return tail.length > 1 ? { kind: "unwrapped", argv: tail.slice(1) } : { kind: "unsafe-exec" };
  }
  // Tail parsing delegates to the shared bunx path so "bun x" and "bunx"
  // accept and reject identical forms (unknown tail options fail closed).
  const unwrapped = unwrapDirectPackageExecInvocation(["bunx", ...tail]);
  return unwrapped ? { kind: "unwrapped", argv: unwrapped } : { kind: "unsafe-exec" };
}

function unwrapYarnDlxInvocation(argv: string[]): string[] | null {
  let idx = 0;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      const tail = argv.slice(idx + 1);
      return tail.length > 0 ? tail : null;
    }
    if (!token.startsWith("-")) {
      return argv.slice(idx);
    }
    const flag = normalizeOptionFlag(token);
    if (YARN_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (YARN_DLX_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapYarnExecInvocation(argv: string[]): string[] | null {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (token === "exec") {
        const tail = argv.slice(idx + 1);
        const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
        return normalizedTail.length > 0 ? normalizedTail : null;
      }
      if (token === "dlx") {
        return unwrapYarnDlxInvocation(argv.slice(idx + 1));
      }
      return null;
    }
    const flag = normalizeOptionFlag(token);
    if (YARN_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (YARN_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

export function unwrapKnownPackageManagerExecInvocation(argv: string[]): string[] | null {
  const resolution = resolveKnownPackageManagerExecInvocation(argv);
  return resolution.kind === "unwrapped" ? resolution.argv : null;
}

export function resolveKnownPackageManagerExecInvocation(
  argv: string[],
): PackageManagerExecInvocation {
  const executable = normalizePackageManagerExecToken(argv[0] ?? "");
  switch (executable) {
    case "npm": {
      const unwrapped = unwrapNpmExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, {
        optionsWithValue: NPM_EXEC_OPTIONS_WITH_VALUE,
        caseSensitiveOptionsWithValue: new Set(["-C"]),
        flagOptions: NPM_EXEC_FLAG_OPTIONS,
      });
      return NPM_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "")
        ? { kind: "unsafe-exec" }
        : firstSubcommand === null && containsSubcommandToken(argv.slice(1), NPM_EXEC_SUBCOMMANDS)
          ? { kind: "unsafe-exec" }
          : { kind: "not-exec" };
    }
    case "npx":
    case "bunx": {
      const unwrapped = unwrapDirectPackageExecInvocation(argv);
      return unwrapped ? { kind: "unwrapped", argv: unwrapped } : { kind: "unsafe-exec" };
    }
    case "bun": {
      return resolveBunExecInvocation(argv);
    }
    case "pnpm": {
      const unwrapped = unwrapPnpmExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, {
        optionsWithValue: new Set([...PNPM_OPTIONS_WITH_VALUE, ...PNPM_DLX_OPTIONS_WITH_VALUE]),
        caseSensitiveOptionsWithValue: PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE,
        flagOptions: PNPM_FLAG_OPTIONS,
      });
      const detectedKnownExec = PNPM_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "");
      const hiddenKnownExec =
        firstSubcommand === null && containsSubcommandToken(argv.slice(1), PNPM_EXEC_SUBCOMMANDS);
      const implicitExecShorthand =
        firstSubcommand !== null &&
        !PNPM_SCRIPT_RUN_SUBCOMMANDS.has(firstSubcommand) &&
        !PNPM_BUILTIN_NON_EXEC_SUBCOMMANDS.has(firstSubcommand);
      return detectedKnownExec || hiddenKnownExec || implicitExecShorthand
        ? { kind: "unsafe-exec" }
        : { kind: "not-exec" };
    }
    case "yarn": {
      const unwrapped = unwrapYarnExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, {
        optionsWithValue: new Set([...YARN_OPTIONS_WITH_VALUE, ...YARN_DLX_OPTIONS_WITH_VALUE]),
        flagOptions: new Set([...YARN_FLAG_OPTIONS, ...YARN_DLX_FLAG_OPTIONS]),
      });
      const detectedKnownExec = YARN_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "");
      const hiddenKnownExec =
        firstSubcommand === null && containsSubcommandToken(argv.slice(1), YARN_EXEC_SUBCOMMANDS);
      const implicitRunOrBin =
        firstSubcommand !== null &&
        (firstSubcommand === "run" || !YARN_BUILTIN_NON_EXEC_SUBCOMMANDS.has(firstSubcommand));
      return detectedKnownExec || hiddenKnownExec || implicitRunOrBin
        ? { kind: "unsafe-exec" }
        : { kind: "not-exec" };
    }
    default:
      return { kind: "not-package-manager" };
  }
}
