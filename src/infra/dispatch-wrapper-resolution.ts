import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

export const MAX_DISPATCH_WRAPPER_DEPTH = 4;

const ENV_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-c",
  "--chdir",
  "-s",
  "--split-string",
  "--default-signal",
  "--ignore-signal",
  "--block-signal",
]);
const ENV_INLINE_VALUE_PREFIXES = [
  "-u",
  "-c",
  "-s",
  "--unset=",
  "--chdir=",
  "--split-string=",
  "--default-signal=",
  "--ignore-signal=",
  "--block-signal=",
] as const;
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);
const NICE_OPTIONS_WITH_VALUE = new Set(["-n", "--adjustment", "--priority"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(["-i", "--input", "-o", "--output", "-e", "--error"]);
const TIME_FLAG_OPTIONS = new Set([
  "-a",
  "--append",
  "-h",
  "--help",
  "-l",
  "-p",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-V",
  "--version",
]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const TIMEOUT_FLAG_OPTIONS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);

type WrapperScanDirective = "continue" | "consume-next" | "stop" | "invalid";

function withWindowsExeAliases(names: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const name of names) {
    expanded.add(name);
    expanded.add(`${name}.exe`);
  }
  return Array.from(expanded);
}

export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function hasEnvInlineValuePrefix(lower: string): boolean {
  for (const prefix of ENV_INLINE_VALUE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function scanWrapperInvocation(
  argv: string[],
  params: {
    separators?: ReadonlySet<string>;
    onToken: (token: string, lowerToken: string) => WrapperScanDirective;
    adjustCommandIndex?: (commandIndex: number, argv: string[]) => number | null;
  },
): string[] | null {
  let idx = 1;
  let expectsOptionValue = false;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (expectsOptionValue) {
      expectsOptionValue = false;
      idx += 1;
      continue;
    }
    if (params.separators?.has(token)) {
      idx += 1;
      break;
    }
    const directive = params.onToken(token, token.toLowerCase());
    if (directive === "stop") {
      break;
    }
    if (directive === "invalid") {
      return null;
    }
    if (directive === "consume-next") {
      expectsOptionValue = true;
    }
    idx += 1;
  }
  if (expectsOptionValue) {
    return null;
  }
  const commandIndex = params.adjustCommandIndex ? params.adjustCommandIndex(idx, argv) : idx;
  if (commandIndex === null || commandIndex >= argv.length) {
    return null;
  }
  return argv.slice(commandIndex);
}

export function unwrapEnvInvocation(argv: string[]): string[] | null {
  return scanWrapperInvocation(argv, {
    separators: new Set(["--", "-"]),
    onToken: (token, lower) => {
      if (isEnvAssignment(token)) {
        return "continue";
      }
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      const [flag] = lower.split("=", 2);
      if (ENV_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      if (hasEnvInlineValuePrefix(lower)) {
        return "continue";
      }
      return "invalid";
    },
  });
}

function envInvocationUsesModifiers(argv: string[]): boolean {
  let idx = 1;
  let expectsOptionValue = false;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (expectsOptionValue) {
      return true;
    }
    if (token === "--" || token === "-") {
      idx += 1;
      break;
    }
    if (isEnvAssignment(token)) {
      return true;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const lower = token.toLowerCase();
    const [flag] = lower.split("=", 2);
    if (ENV_FLAG_OPTIONS.has(flag)) {
      return true;
    }
    if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
      if (lower.includes("=")) {
        return true;
      }
      expectsOptionValue = true;
      idx += 1;
      continue;
    }
    if (hasEnvInlineValuePrefix(lower)) {
      return true;
    }
    return true;
  }

  return false;
}

function unwrapDashOptionInvocation(
  argv: string[],
  params: {
    onFlag: (flag: string, lowerToken: string) => WrapperScanDirective;
    adjustCommandIndex?: (commandIndex: number, argv: string[]) => number | null;
  },
): string[] | null {
  return scanWrapperInvocation(argv, {
    separators: new Set(["--"]),
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      const [flag] = lower.split("=", 2);
      return params.onFlag(flag, lower);
    },
    adjustCommandIndex: params.adjustCommandIndex,
  });
}

function unwrapNiceInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (/^-\d+$/.test(lower)) {
        return "continue";
      }
      if (NICE_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") || lower !== flag ? "continue" : "consume-next";
      }
      if (lower.startsWith("-n") && lower.length > 2) {
        return "continue";
      }
      return "invalid";
    },
  });
}

function unwrapNohupInvocation(argv: string[]): string[] | null {
  return scanWrapperInvocation(argv, {
    separators: new Set(["--"]),
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      return lower === "--help" || lower === "--version" ? "continue" : "invalid";
    },
  });
}

function unwrapStdbufInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (!STDBUF_OPTIONS_WITH_VALUE.has(flag)) {
        return "invalid";
      }
      return lower.includes("=") ? "continue" : "consume-next";
    },
  });
}

function unwrapTimeInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (TIME_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (TIME_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
  });
}

function unwrapTimeoutInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (TIMEOUT_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (TIMEOUT_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
    adjustCommandIndex: (commandIndex, currentArgv) => {
      const wrappedCommandIndex = commandIndex + 1;
      return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
    },
  });
}

type DispatchWrapperSpec = {
  name: string;
  unwrap?: (argv: string[]) => string[] | null;
  transparentUsage?: boolean | ((argv: string[]) => boolean);
};

const DISPATCH_WRAPPER_SPECS: readonly DispatchWrapperSpec[] = [
  { name: "chrt" },
  { name: "doas" },
  {
    name: "env",
    unwrap: unwrapEnvInvocation,
    transparentUsage: (argv) => !envInvocationUsesModifiers(argv),
  },
  { name: "ionice" },
  { name: "nice", unwrap: unwrapNiceInvocation, transparentUsage: true },
  { name: "nohup", unwrap: unwrapNohupInvocation, transparentUsage: true },
  { name: "setsid" },
  { name: "stdbuf", unwrap: unwrapStdbufInvocation, transparentUsage: true },
  { name: "sudo" },
  { name: "taskset" },
  { name: "time", unwrap: unwrapTimeInvocation, transparentUsage: true },
  { name: "timeout", unwrap: unwrapTimeoutInvocation, transparentUsage: true },
];

const DISPATCH_WRAPPER_SPEC_BY_NAME = new Map(
  DISPATCH_WRAPPER_SPECS.map((spec) => [spec.name, spec] as const),
);

export const DISPATCH_WRAPPER_EXECUTABLES = new Set(
  withWindowsExeAliases(DISPATCH_WRAPPER_SPECS.map((spec) => spec.name)),
);

export type DispatchWrapperUnwrapResult =
  | { kind: "not-wrapper" }
  | { kind: "blocked"; wrapper: string }
  | { kind: "unwrapped"; wrapper: string; argv: string[] };

export type DispatchWrapperExecutionPlan = {
  argv: string[];
  wrappers: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
};

function blockDispatchWrapper(wrapper: string): DispatchWrapperUnwrapResult {
  return { kind: "blocked", wrapper };
}

function unwrapDispatchWrapper(
  wrapper: string,
  unwrapped: string[] | null,
): DispatchWrapperUnwrapResult {
  return unwrapped
    ? { kind: "unwrapped", wrapper, argv: unwrapped }
    : blockDispatchWrapper(wrapper);
}

export function isDispatchWrapperExecutable(token: string): boolean {
  return DISPATCH_WRAPPER_SPEC_BY_NAME.has(normalizeExecutableToken(token));
}

export function unwrapKnownDispatchWrapperInvocation(argv: string[]): DispatchWrapperUnwrapResult {
  const token0 = argv[0]?.trim();
  if (!token0) {
    return { kind: "not-wrapper" };
  }
  const wrapper = normalizeExecutableToken(token0);
  const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
  if (!spec) {
    return { kind: "not-wrapper" };
  }
  return spec.unwrap
    ? unwrapDispatchWrapper(wrapper, spec.unwrap(argv))
    : blockDispatchWrapper(wrapper);
}

export function unwrapDispatchWrappersForResolution(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
): string[] {
  const plan = resolveDispatchWrapperExecutionPlan(argv, maxDepth);
  return plan.argv;
}

function isSemanticDispatchWrapperUsage(wrapper: string, argv: string[]): boolean {
  const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
  if (!spec?.unwrap) {
    return true;
  }
  const transparentUsage = spec.transparentUsage;
  if (typeof transparentUsage === "function") {
    return !transparentUsage(argv);
  }
  return transparentUsage !== true;
}

function blockedDispatchWrapperPlan(params: {
  argv: string[];
  wrappers: string[];
  blockedWrapper: string;
}): DispatchWrapperExecutionPlan {
  return {
    argv: params.argv,
    wrappers: params.wrappers,
    policyBlocked: true,
    blockedWrapper: params.blockedWrapper,
  };
}

export function resolveDispatchWrapperExecutionPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
): DispatchWrapperExecutionPlan {
  let current = argv;
  const wrappers: string[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const unwrap = unwrapKnownDispatchWrapperInvocation(current);
    if (unwrap.kind === "blocked") {
      return blockedDispatchWrapperPlan({
        argv: current,
        wrappers,
        blockedWrapper: unwrap.wrapper,
      });
    }
    if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) {
      break;
    }
    wrappers.push(unwrap.wrapper);
    if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current)) {
      return blockedDispatchWrapperPlan({
        argv: current,
        wrappers,
        blockedWrapper: unwrap.wrapper,
      });
    }
    current = unwrap.argv;
  }
  if (wrappers.length >= maxDepth) {
    const overflow = unwrapKnownDispatchWrapperInvocation(current);
    if (overflow.kind === "blocked" || overflow.kind === "unwrapped") {
      return blockedDispatchWrapperPlan({
        argv: current,
        wrappers,
        blockedWrapper: overflow.wrapper,
      });
    }
  }
  return { argv: current, wrappers, policyBlocked: false };
}

export function hasDispatchEnvManipulation(argv: string[]): boolean {
  const unwrap = unwrapKnownDispatchWrapperInvocation(argv);
  return (
    unwrap.kind === "unwrapped" && unwrap.wrapper === "env" && envInvocationUsesModifiers(argv)
  );
}
