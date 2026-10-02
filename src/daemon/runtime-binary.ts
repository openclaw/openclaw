/** Classifies runtime executable paths for daemon command rendering. */
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;

function normalizeRuntimeBasename(execPath: string): string {
  const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const basename = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return basename.trim().toLowerCase();
}

/** Returns whether an executable path names a Node runtime binary. */
export function isNodeRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return /^node(?:js)?(?:\.exe)?$/.test(base) || NODE_VERSIONED_PATTERN.test(base);
}

/** Returns whether an executable path names a Bun runtime binary. */
export function isBunRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return base === "bun" || base === "bun.exe";
}

const RUNTIME_MODULE_OPTIONS = new Set([
  "-r",
  "--preload",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--test-reporter",
  "--test-global-setup",
]);
const RUNTIME_VALUE_OPTIONS = new Set([
  ...RUNTIME_MODULE_OPTIONS,
  "-C",
  "--env-file",
  "--env-file-if-exists",
  "--tsconfig",
  "--cwd",
  "--conditions",
  "--icu-data-dir",
  "--openssl-config",
  "--title",
  "--disable-warning",
  "--disable-proto",
  "--cpu-prof-name",
  "--max-old-space-size",
  "--max-semi-space-size",
]);
const RUNTIME_BOOLEAN_OPTIONS = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--expose-gc",
  "--jitless",
  "--no-opt",
  "--experimental-strip-types",
  "--watch",
  "--no-warnings",
  "--trace-uncaught",
  "--bun",
]);

/** One runtime walk preserves command identity and possible artifact operands. */
export function resolveRuntimeScriptPosition(args: string[]): {
  position: number | { kind: "not-runtime" | "other" } | { kind: "unclassified"; reason: string };
  operands: Array<{ value: string; module: boolean }>;
} {
  const operands: Array<{ value: string; module: boolean }> = [];
  const executable = args[0] ?? "";
  const basename = executable.replaceAll("\\", "/").trim().toLowerCase().split("/").at(-1);
  const bun = isBunRuntime(executable);
  const tsx = basename === "tsx" || basename === "tsx.cmd";
  let pendingSubcommand: "run" | "watch" | undefined = bun ? "run" : tsx ? "watch" : undefined;
  let unresolved: { kind: "unclassified"; reason: string } | undefined;
  let inlineCommand = false;
  if (!isNodeRuntime(executable) && !bun && !tsx) {
    return { position: { kind: "not-runtime" }, operands };
  }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      if (!unresolved) {
        return {
          position: !inlineCommand && args[index + 1] ? index + 1 : { kind: "other" },
          operands,
        };
      }
      operands.push(...args.slice(index + 1).map((value) => ({ value, module: false })));
      break;
    }
    if (arg === "-e" || arg === "-p" || /^--(?:eval|print|run)(?:=|$)/.test(arg)) {
      inlineCommand = true;
      if (!arg.includes("=")) {
        index++;
      }
      continue;
    }
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    if (arg.startsWith("-r") && !arg.startsWith("--") && arg.length > 2) {
      operands.push({ value: arg.slice(2), module: true });
    } else if (RUNTIME_VALUE_OPTIONS.has(option)) {
      const value = equals < 0 ? (args[++index] ?? "") : arg.slice(equals + 1);
      // These reporters have been built in since Node introduced --test-reporter.
      const builtinReporter =
        !bun && option === "--test-reporter" && /^(?:dot|spec|tap)$/.test(value);
      if (
        RUNTIME_MODULE_OPTIONS.has(option) &&
        !builtinReporter &&
        (!bun || option !== "--loader")
      ) {
        operands.push({ value, module: true });
      }
    } else if (arg.startsWith("-")) {
      // A negated spelling proves a boolean; its absence never proves a value option.
      const negated = `--no-${option.replace(/^--(?:no-)?/, "")}`;
      const nodeOption = !bun && process.allowedNodeEnvironmentFlags.has(option);
      const knownBoolean =
        RUNTIME_BOOLEAN_OPTIONS.has(option) ||
        (bun && option === "--hot") ||
        (nodeOption && process.allowedNodeEnvironmentFlags.has(negated));
      if (!inlineCommand && !knownBoolean && !/^--[^=]+=/.test(arg)) {
        unresolved ??= { kind: "unclassified", reason: `unsupported runtime option ${arg}` };
      }
      if (equals >= 0 && !knownBoolean && !nodeOption) {
        operands.push({ value: arg.slice(equals + 1), module: true });
      }
    } else if (!inlineCommand && arg === pendingSubcommand) {
      pendingSubcommand = undefined;
    } else if (!inlineCommand) {
      if (!unresolved) {
        return { position: index, operands };
      }
      pendingSubcommand = undefined;
      operands.push({ value: arg, module: false });
    }
  }
  return { position: unresolved ?? { kind: "other" }, operands };
}
