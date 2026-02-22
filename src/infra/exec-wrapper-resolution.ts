import path from "node:path";

export const MAX_DISPATCH_WRAPPER_DEPTH = 4;

export const POSIX_SHELL_WRAPPERS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);
export const WINDOWS_CMD_WRAPPERS = new Set(["cmd.exe", "cmd"]);
export const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

const POSIX_INLINE_COMMAND_FLAGS = new Set(["-lc", "-c", "--command"]);
const POWERSHELL_INLINE_COMMAND_FLAGS = new Set(["-c", "-command", "--command"]);

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
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);

type ShellWrapperKind = "posix" | "cmd" | "powershell";

type ShellWrapperSpec = {
  kind: ShellWrapperKind;
  names: ReadonlySet<string>;
};

const SHELL_WRAPPER_SPECS: ReadonlyArray<ShellWrapperSpec> = [
  { kind: "posix", names: POSIX_SHELL_WRAPPERS },
  { kind: "cmd", names: WINDOWS_CMD_WRAPPERS },
  { kind: "powershell", names: POWERSHELL_WRAPPERS },
];

export type ShellWrapperCommand = {
  isWrapper: boolean;
  command: string | null;
};

export function basenameLower(token: string): string {
  const win = path.win32.basename(token);
  const posix = path.posix.basename(token);
  const base = win.length < posix.length ? win : posix;
  return base.trim().toLowerCase();
}

function normalizeRawCommand(rawCommand?: string | null): string | null {
  const trimmed = rawCommand?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function findShellWrapperSpec(baseExecutable: string): ShellWrapperSpec | null {
  for (const spec of SHELL_WRAPPER_SPECS) {
    if (spec.names.has(baseExecutable)) {
      return spec;
    }
  }
  return null;
}

export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

export function unwrapEnvInvocation(argv: string[]): string[] | null {
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
    if (token === "--" || token === "-") {
      idx += 1;
      break;
    }
    if (isEnvAssignment(token)) {
      idx += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const lower = token.toLowerCase();
      const [flag] = lower.split("=", 2);
      if (ENV_FLAG_OPTIONS.has(flag)) {
        idx += 1;
        continue;
      }
      if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
        if (!lower.includes("=")) {
          expectsOptionValue = true;
        }
        idx += 1;
        continue;
      }
      if (
        lower.startsWith("-u") ||
        lower.startsWith("-c") ||
        lower.startsWith("-s") ||
        lower.startsWith("--unset=") ||
        lower.startsWith("--chdir=") ||
        lower.startsWith("--split-string=") ||
        lower.startsWith("--default-signal=") ||
        lower.startsWith("--ignore-signal=") ||
        lower.startsWith("--block-signal=")
      ) {
        idx += 1;
        continue;
      }
      return null;
    }
    break;
  }
  return idx < argv.length ? argv.slice(idx) : null;
}

export function unwrapDispatchWrappersForResolution(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
): string[] {
  let current = argv;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const token0 = current[0]?.trim();
    if (!token0) {
      break;
    }
    if (basenameLower(token0) !== "env") {
      break;
    }
    const unwrapped = unwrapEnvInvocation(current);
    if (!unwrapped || unwrapped.length === 0) {
      break;
    }
    current = unwrapped;
  }
  return current;
}

function extractPosixShellInlineCommand(argv: string[]): string | null {
  const flag = argv[1]?.trim();
  if (!flag) {
    return null;
  }
  if (!POSIX_INLINE_COMMAND_FLAGS.has(flag.toLowerCase())) {
    return null;
  }
  const cmd = argv[2]?.trim();
  return cmd ? cmd : null;
}

function extractCmdInlineCommand(argv: string[]): string | null {
  const idx = argv.findIndex((item) => item.trim().toLowerCase() === "/c");
  if (idx === -1) {
    return null;
  }
  const tail = argv.slice(idx + 1);
  if (tail.length === 0) {
    return null;
  }
  const cmd = tail.join(" ").trim();
  return cmd.length > 0 ? cmd : null;
}

function extractPowerShellInlineCommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "--") {
      break;
    }
    if (POWERSHELL_INLINE_COMMAND_FLAGS.has(lower)) {
      const cmd = argv[i + 1]?.trim();
      return cmd ? cmd : null;
    }
  }
  return null;
}

function extractShellWrapperPayload(argv: string[], spec: ShellWrapperSpec): string | null {
  switch (spec.kind) {
    case "posix":
      return extractPosixShellInlineCommand(argv);
    case "cmd":
      return extractCmdInlineCommand(argv);
    case "powershell":
      return extractPowerShellInlineCommand(argv);
  }
}

function extractShellWrapperCommandInternal(
  argv: string[],
  rawCommand: string | null,
  depth: number,
): ShellWrapperCommand {
  if (depth >= MAX_DISPATCH_WRAPPER_DEPTH) {
    return { isWrapper: false, command: null };
  }

  const token0 = argv[0]?.trim();
  if (!token0) {
    return { isWrapper: false, command: null };
  }

  const base0 = basenameLower(token0);
  if (base0 === "env") {
    const unwrapped = unwrapEnvInvocation(argv);
    if (!unwrapped) {
      return { isWrapper: false, command: null };
    }
    return extractShellWrapperCommandInternal(unwrapped, rawCommand, depth + 1);
  }

  const wrapper = findShellWrapperSpec(base0);
  if (!wrapper) {
    return { isWrapper: false, command: null };
  }

  const payload = extractShellWrapperPayload(argv, wrapper);
  if (!payload) {
    return { isWrapper: false, command: null };
  }

  return { isWrapper: true, command: rawCommand ?? payload };
}

export function extractShellWrapperCommand(
  argv: string[],
  rawCommand?: string | null,
): ShellWrapperCommand {
  return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
}
