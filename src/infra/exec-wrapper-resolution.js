import path from "node:path";
export const MAX_DISPATCH_WRAPPER_DEPTH = 4;
const WINDOWS_EXE_SUFFIX = ".exe";
const POSIX_SHELL_WRAPPER_NAMES = ["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"];
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"];
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"];
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"];
const DISPATCH_WRAPPER_NAMES = [
    "chrt",
    "doas",
    "env",
    "ionice",
    "nice",
    "nohup",
    "setsid",
    "stdbuf",
    "sudo",
    "taskset",
    "timeout",
];
function withWindowsExeAliases(names) {
    const expanded = new Set();
    for (const name of names) {
        expanded.add(name);
        expanded.add(`${name}${WINDOWS_EXE_SUFFIX}`);
    }
    return Array.from(expanded);
}
function stripWindowsExeSuffix(value) {
    return value.endsWith(WINDOWS_EXE_SUFFIX) ? value.slice(0, -WINDOWS_EXE_SUFFIX.length) : value;
}
export const POSIX_SHELL_WRAPPERS = new Set(POSIX_SHELL_WRAPPER_NAMES);
export const WINDOWS_CMD_WRAPPERS = new Set(withWindowsExeAliases(WINDOWS_CMD_WRAPPER_NAMES));
export const POWERSHELL_WRAPPERS = new Set(withWindowsExeAliases(POWERSHELL_WRAPPER_NAMES));
export const DISPATCH_WRAPPER_EXECUTABLES = new Set(withWindowsExeAliases(DISPATCH_WRAPPER_NAMES));
const POSIX_SHELL_WRAPPER_CANONICAL = new Set(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPER_CANONICAL = new Set(WINDOWS_CMD_WRAPPER_NAMES);
const POWERSHELL_WRAPPER_CANONICAL = new Set(POWERSHELL_WRAPPER_NAMES);
const SHELL_MULTIPLEXER_WRAPPER_CANONICAL = new Set(SHELL_MULTIPLEXER_WRAPPER_NAMES);
const DISPATCH_WRAPPER_CANONICAL = new Set(DISPATCH_WRAPPER_NAMES);
const SHELL_WRAPPER_CANONICAL = new Set([
    ...POSIX_SHELL_WRAPPER_NAMES,
    ...WINDOWS_CMD_WRAPPER_NAMES,
    ...POWERSHELL_WRAPPER_NAMES,
]);
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
];
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);
const NICE_OPTIONS_WITH_VALUE = new Set(["-n", "--adjustment", "--priority"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(["-i", "--input", "-o", "--output", "-e", "--error"]);
const TIMEOUT_FLAG_OPTIONS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);
const TRANSPARENT_DISPATCH_WRAPPERS = new Set(["nice", "nohup", "stdbuf", "timeout"]);
const SHELL_WRAPPER_SPECS = [
    { kind: "posix", names: POSIX_SHELL_WRAPPER_CANONICAL },
    { kind: "cmd", names: WINDOWS_CMD_WRAPPER_CANONICAL },
    { kind: "powershell", names: POWERSHELL_WRAPPER_CANONICAL },
];
export function basenameLower(token) {
    const win = path.win32.basename(token);
    const posix = path.posix.basename(token);
    const base = win.length < posix.length ? win : posix;
    return base.trim().toLowerCase();
}
export function normalizeExecutableToken(token) {
    return stripWindowsExeSuffix(basenameLower(token));
}
export function isDispatchWrapperExecutable(token) {
    return DISPATCH_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
export function isShellWrapperExecutable(token) {
    return SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
function normalizeRawCommand(rawCommand) {
    const trimmed = rawCommand?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}
function findShellWrapperSpec(baseExecutable) {
    const canonicalBase = stripWindowsExeSuffix(baseExecutable);
    for (const spec of SHELL_WRAPPER_SPECS) {
        if (spec.names.has(canonicalBase)) {
            return spec;
        }
    }
    return null;
}
export function unwrapKnownShellMultiplexerInvocation(argv) {
    const token0 = argv[0]?.trim();
    if (!token0) {
        return { kind: "not-wrapper" };
    }
    const wrapper = normalizeExecutableToken(token0);
    if (!SHELL_MULTIPLEXER_WRAPPER_CANONICAL.has(wrapper)) {
        return { kind: "not-wrapper" };
    }
    let appletIndex = 1;
    if (argv[appletIndex]?.trim() === "--") {
        appletIndex += 1;
    }
    const applet = argv[appletIndex]?.trim();
    if (!applet || !isShellWrapperExecutable(applet)) {
        return { kind: "blocked", wrapper };
    }
    const unwrapped = argv.slice(appletIndex);
    if (unwrapped.length === 0) {
        return { kind: "blocked", wrapper };
    }
    return { kind: "unwrapped", wrapper, argv: unwrapped };
}
export function isEnvAssignment(token) {
    return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}
function hasEnvInlineValuePrefix(lower) {
    for (const prefix of ENV_INLINE_VALUE_PREFIXES) {
        if (lower.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}
function scanWrapperInvocation(argv, params) {
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
export function unwrapEnvInvocation(argv) {
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
function envInvocationUsesModifiers(argv) {
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
        // Unknown env flags are treated conservatively as modifiers.
        return true;
    }
    return false;
}
function unwrapNiceInvocation(argv) {
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
function unwrapNohupInvocation(argv) {
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
function unwrapDashOptionInvocation(argv, params) {
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
function unwrapStdbufInvocation(argv) {
    return unwrapDashOptionInvocation(argv, {
        onFlag: (flag, lower) => {
            if (!STDBUF_OPTIONS_WITH_VALUE.has(flag)) {
                return "invalid";
            }
            return lower.includes("=") ? "continue" : "consume-next";
        },
    });
}
function unwrapTimeoutInvocation(argv) {
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
            // timeout consumes a required duration token before the wrapped command.
            const wrappedCommandIndex = commandIndex + 1;
            return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
        },
    });
}
function blockDispatchWrapper(wrapper) {
    return { kind: "blocked", wrapper };
}
function unwrapDispatchWrapper(wrapper, unwrapped) {
    return unwrapped
        ? { kind: "unwrapped", wrapper, argv: unwrapped }
        : blockDispatchWrapper(wrapper);
}
export function unwrapKnownDispatchWrapperInvocation(argv) {
    const token0 = argv[0]?.trim();
    if (!token0) {
        return { kind: "not-wrapper" };
    }
    const wrapper = normalizeExecutableToken(token0);
    switch (wrapper) {
        case "env":
            return unwrapDispatchWrapper(wrapper, unwrapEnvInvocation(argv));
        case "nice":
            return unwrapDispatchWrapper(wrapper, unwrapNiceInvocation(argv));
        case "nohup":
            return unwrapDispatchWrapper(wrapper, unwrapNohupInvocation(argv));
        case "stdbuf":
            return unwrapDispatchWrapper(wrapper, unwrapStdbufInvocation(argv));
        case "timeout":
            return unwrapDispatchWrapper(wrapper, unwrapTimeoutInvocation(argv));
        case "chrt":
        case "doas":
        case "ionice":
        case "setsid":
        case "sudo":
        case "taskset":
            return blockDispatchWrapper(wrapper);
        default:
            return { kind: "not-wrapper" };
    }
}
export function unwrapDispatchWrappersForResolution(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH) {
    const plan = resolveDispatchWrapperExecutionPlan(argv, maxDepth);
    return plan.argv;
}
function isSemanticDispatchWrapperUsage(wrapper, argv) {
    if (wrapper === "env") {
        return envInvocationUsesModifiers(argv);
    }
    return !TRANSPARENT_DISPATCH_WRAPPERS.has(wrapper);
}
function blockedDispatchWrapperPlan(params) {
    return {
        argv: params.argv,
        wrappers: params.wrappers,
        policyBlocked: true,
        blockedWrapper: params.blockedWrapper,
    };
}
export function resolveDispatchWrapperExecutionPlan(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH) {
    let current = argv;
    const wrappers = [];
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
function hasEnvManipulationBeforeShellWrapperInternal(argv, depth, envManipulationSeen) {
    if (depth >= MAX_DISPATCH_WRAPPER_DEPTH) {
        return false;
    }
    const token0 = argv[0]?.trim();
    if (!token0) {
        return false;
    }
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(argv);
    if (dispatchUnwrap.kind === "blocked") {
        return false;
    }
    if (dispatchUnwrap.kind === "unwrapped") {
        const nextEnvManipulationSeen = envManipulationSeen || (dispatchUnwrap.wrapper === "env" && envInvocationUsesModifiers(argv));
        return hasEnvManipulationBeforeShellWrapperInternal(dispatchUnwrap.argv, depth + 1, nextEnvManipulationSeen);
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(argv);
    if (shellMultiplexerUnwrap.kind === "blocked") {
        return false;
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
        return hasEnvManipulationBeforeShellWrapperInternal(shellMultiplexerUnwrap.argv, depth + 1, envManipulationSeen);
    }
    const wrapper = findShellWrapperSpec(normalizeExecutableToken(token0));
    if (!wrapper) {
        return false;
    }
    const payload = extractShellWrapperPayload(argv, wrapper);
    if (!payload) {
        return false;
    }
    return envManipulationSeen;
}
export function hasEnvManipulationBeforeShellWrapper(argv) {
    return hasEnvManipulationBeforeShellWrapperInternal(argv, 0, false);
}
function extractPosixShellInlineCommand(argv) {
    return extractInlineCommandByFlags(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
}
function extractCmdInlineCommand(argv) {
    const idx = argv.findIndex((item) => {
        const token = item.trim().toLowerCase();
        return token === "/c" || token === "/k";
    });
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
function extractPowerShellInlineCommand(argv) {
    return extractInlineCommandByFlags(argv, POWERSHELL_INLINE_COMMAND_FLAGS);
}
function extractInlineCommandByFlags(argv, flags, options = {}) {
    for (let i = 1; i < argv.length; i += 1) {
        const token = argv[i]?.trim();
        if (!token) {
            continue;
        }
        const lower = token.toLowerCase();
        if (lower === "--") {
            break;
        }
        if (flags.has(lower)) {
            const cmd = argv[i + 1]?.trim();
            return cmd ? cmd : null;
        }
        if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
            const commandIndex = lower.indexOf("c");
            const inline = token.slice(commandIndex + 1).trim();
            if (inline) {
                return inline;
            }
            const cmd = argv[i + 1]?.trim();
            return cmd ? cmd : null;
        }
    }
    return null;
}
function extractShellWrapperPayload(argv, spec) {
    switch (spec.kind) {
        case "posix":
            return extractPosixShellInlineCommand(argv);
        case "cmd":
            return extractCmdInlineCommand(argv);
        case "powershell":
            return extractPowerShellInlineCommand(argv);
    }
}
function extractShellWrapperCommandInternal(argv, rawCommand, depth) {
    if (depth >= MAX_DISPATCH_WRAPPER_DEPTH) {
        return { isWrapper: false, command: null };
    }
    const token0 = argv[0]?.trim();
    if (!token0) {
        return { isWrapper: false, command: null };
    }
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(argv);
    if (dispatchUnwrap.kind === "blocked") {
        return { isWrapper: false, command: null };
    }
    if (dispatchUnwrap.kind === "unwrapped") {
        return extractShellWrapperCommandInternal(dispatchUnwrap.argv, rawCommand, depth + 1);
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(argv);
    if (shellMultiplexerUnwrap.kind === "blocked") {
        return { isWrapper: false, command: null };
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
        return extractShellWrapperCommandInternal(shellMultiplexerUnwrap.argv, rawCommand, depth + 1);
    }
    const base0 = normalizeExecutableToken(token0);
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
export function extractShellWrapperInlineCommand(argv) {
    const extracted = extractShellWrapperCommandInternal(argv, null, 0);
    return extracted.isWrapper ? extracted.command : null;
}
export function extractShellWrapperCommand(argv, rawCommand) {
    return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
}
