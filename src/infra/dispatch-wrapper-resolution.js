import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
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
];
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);
const NICE_OPTIONS_WITH_VALUE = new Set(["-n", "--adjustment", "--priority"]);
const CAFFEINATE_OPTIONS_WITH_VALUE = new Set(["-t", "-w"]);
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
const BSD_SCRIPT_FLAG_OPTIONS = new Set(["-a", "-d", "-k", "-p", "-q", "-r"]);
const BSD_SCRIPT_OPTIONS_WITH_VALUE = new Set(["-F", "-t"]);
const SANDBOX_EXEC_OPTIONS_WITH_VALUE = new Set(["-f", "-p", "-d"]);
const TIMEOUT_FLAG_OPTIONS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);
const XCRUN_FLAG_OPTIONS = new Set([
    "-k",
    "--kill-cache",
    "-l",
    "--log",
    "-n",
    "--no-cache",
    "-r",
    "--run",
    "-v",
    "--verbose",
]);
function isArchSelectorToken(token) {
    return /^-[A-Za-z0-9_]+$/.test(token);
}
function isKnownArchSelectorToken(token) {
    return (token === "-arm64" ||
        token === "-arm64e" ||
        token === "-i386" ||
        token === "-x86_64" ||
        token === "-x86_64h");
}
function isKnownArchNameToken(token) {
    return isKnownArchSelectorToken(`-${token}`);
}
function withWindowsExeAliases(names) {
    const expanded = new Set();
    for (const name of names) {
        expanded.add(name);
        expanded.add(`${name}.exe`);
    }
    return Array.from(expanded);
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
        const directive = params.onToken(token, normalizeLowercaseStringOrEmpty(token));
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
    const parsed = parseEnvInvocationPrelude(argv);
    return parsed ? argv.slice(parsed.commandIndex) : null;
}
function parseEnvInvocationPrelude(argv) {
    let idx = 1;
    let expectsOptionValue = false;
    const assignmentKeys = [];
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
            const delimiter = token.indexOf("=");
            if (delimiter > 0) {
                assignmentKeys.push(token.slice(0, delimiter));
            }
            idx += 1;
            continue;
        }
        if (!token.startsWith("-") || token === "-") {
            break;
        }
        const lower = normalizeLowercaseStringOrEmpty(token);
        const [flag] = lower.split("=", 2);
        if (ENV_FLAG_OPTIONS.has(flag)) {
            idx += 1;
            continue;
        }
        if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
            if (lower.includes("=")) {
                idx += 1;
                continue;
            }
            expectsOptionValue = true;
            idx += 1;
            continue;
        }
        if (hasEnvInlineValuePrefix(lower)) {
            idx += 1;
            continue;
        }
        return null;
    }
    if (expectsOptionValue || idx >= argv.length) {
        return null;
    }
    return {
        assignmentKeys,
        commandIndex: idx,
    };
}
export function extractEnvAssignmentKeysFromDispatchWrappers(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH) {
    let current = argv;
    const assignmentKeys = [];
    for (let depth = 0; depth < maxDepth; depth += 1) {
        const unwrap = unwrapKnownDispatchWrapperInvocation(current);
        if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) {
            break;
        }
        if (unwrap.wrapper === "env") {
            const parsed = parseEnvInvocationPrelude(current);
            if (parsed) {
                assignmentKeys.push(...parsed.assignmentKeys);
            }
        }
        current = unwrap.argv;
    }
    return Array.from(new Set(assignmentKeys)).toSorted((a, b) => a.localeCompare(b));
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
        const lower = normalizeLowercaseStringOrEmpty(token);
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
function unwrapCaffeinateInvocation(argv) {
    return unwrapDashOptionInvocation(argv, {
        onFlag: (flag, lower) => {
            if (flag === "-d" || flag === "-i" || flag === "-m" || flag === "-s" || flag === "-u") {
                return "continue";
            }
            if (CAFFEINATE_OPTIONS_WITH_VALUE.has(flag)) {
                return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
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
function unwrapSandboxExecInvocation(argv) {
    return unwrapDashOptionInvocation(argv, {
        onFlag: (flag, lower) => {
            if (SANDBOX_EXEC_OPTIONS_WITH_VALUE.has(flag)) {
                return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
            }
            return "invalid";
        },
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
function unwrapTimeInvocation(argv) {
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
function supportsScriptPositionalCommand(platform = process.platform) {
    return platform === "darwin" || platform === "freebsd";
}
function unwrapScriptInvocation(argv) {
    if (!supportsScriptPositionalCommand()) {
        return null;
    }
    return scanWrapperInvocation(argv, {
        separators: new Set(["--"]),
        onToken: (token, lower) => {
            if (!lower.startsWith("-") || lower === "-") {
                return "stop";
            }
            const [flag] = token.split("=", 2);
            if (BSD_SCRIPT_OPTIONS_WITH_VALUE.has(flag)) {
                return token.includes("=") ? "continue" : "consume-next";
            }
            if (BSD_SCRIPT_FLAG_OPTIONS.has(flag)) {
                return "continue";
            }
            return "invalid";
        },
        adjustCommandIndex: (commandIndex, currentArgv) => {
            let sawTranscript = false;
            for (let idx = commandIndex; idx < currentArgv.length; idx += 1) {
                const token = currentArgv[idx]?.trim() ?? "";
                if (!token) {
                    continue;
                }
                if (!sawTranscript) {
                    sawTranscript = true;
                    continue;
                }
                return idx;
            }
            return null;
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
            const wrappedCommandIndex = commandIndex + 1;
            return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
        },
    });
}
function unwrapArchInvocation(argv) {
    let expectsArchName = false;
    return scanWrapperInvocation(argv, {
        onToken: (token, lower) => {
            if (expectsArchName) {
                expectsArchName = false;
                return isKnownArchNameToken(lower) ? "continue" : "invalid";
            }
            if (!token.startsWith("-") || token === "-") {
                return "stop";
            }
            if (lower === "-32" || lower === "-64") {
                return "continue";
            }
            if (lower === "-arch") {
                expectsArchName = true;
                return "continue";
            }
            // `arch` can also mutate the launched environment, which is not transparent.
            if (lower === "-c" || lower === "-d" || lower === "-e" || lower === "-h") {
                return "invalid";
            }
            return isArchSelectorToken(token) && isKnownArchSelectorToken(lower) ? "continue" : "invalid";
        },
    });
}
function supportsArchDispatchWrapper(platform = process.platform) {
    return platform === "darwin";
}
function supportsXcrunDispatchWrapper(platform = process.platform) {
    return platform === "darwin";
}
function unwrapXcrunInvocation(argv) {
    return scanWrapperInvocation(argv, {
        onToken: (token, lower) => {
            if (!token.startsWith("-") || token === "-") {
                return "stop";
            }
            if (XCRUN_FLAG_OPTIONS.has(lower)) {
                return "continue";
            }
            return "invalid";
        },
    });
}
const DISPATCH_WRAPPER_SPECS = [
    {
        name: "arch",
        unwrap: (argv, platform) => supportsArchDispatchWrapper(platform) ? unwrapArchInvocation(argv) : null,
        transparentUsage: (_argv, platform) => supportsArchDispatchWrapper(platform),
    },
    { name: "caffeinate", unwrap: unwrapCaffeinateInvocation, transparentUsage: true },
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
    { name: "sandbox-exec", unwrap: unwrapSandboxExecInvocation, transparentUsage: true },
    { name: "script", unwrap: unwrapScriptInvocation, transparentUsage: true },
    { name: "setsid" },
    { name: "stdbuf", unwrap: unwrapStdbufInvocation, transparentUsage: true },
    { name: "sudo" },
    { name: "taskset" },
    { name: "time", unwrap: unwrapTimeInvocation, transparentUsage: true },
    { name: "timeout", unwrap: unwrapTimeoutInvocation, transparentUsage: true },
    {
        name: "xcrun",
        unwrap: (argv, platform) => supportsXcrunDispatchWrapper(platform) ? unwrapXcrunInvocation(argv) : null,
        transparentUsage: (_argv, platform) => supportsXcrunDispatchWrapper(platform),
    },
];
const DISPATCH_WRAPPER_SPEC_BY_NAME = new Map(DISPATCH_WRAPPER_SPECS.map((spec) => [spec.name, spec]));
export const DISPATCH_WRAPPER_EXECUTABLES = new Set(withWindowsExeAliases(DISPATCH_WRAPPER_SPECS.map((spec) => spec.name)));
function blockDispatchWrapper(wrapper) {
    return { kind: "blocked", wrapper };
}
function unwrapDispatchWrapper(wrapper, unwrapped) {
    return unwrapped
        ? { kind: "unwrapped", wrapper, argv: unwrapped }
        : blockDispatchWrapper(wrapper);
}
export function isDispatchWrapperExecutable(token) {
    return DISPATCH_WRAPPER_SPEC_BY_NAME.has(normalizeExecutableToken(token));
}
export function unwrapKnownDispatchWrapperInvocation(argv, platform = process.platform) {
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
        ? unwrapDispatchWrapper(wrapper, spec.unwrap(argv, platform))
        : blockDispatchWrapper(wrapper);
}
export function unwrapDispatchWrappersForResolution(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH, platform = process.platform) {
    const plan = resolveDispatchWrapperTrustPlan(argv, maxDepth, platform);
    return plan.argv;
}
function isSemanticDispatchWrapperUsage(wrapper, argv, platform = process.platform) {
    const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
    if (!spec?.unwrap) {
        return true;
    }
    const transparentUsage = spec.transparentUsage;
    if (typeof transparentUsage === "function") {
        return !transparentUsage(argv, platform);
    }
    return transparentUsage !== true;
}
function blockedDispatchWrapperPlan(params) {
    return {
        argv: params.argv,
        wrappers: params.wrappers,
        policyBlocked: true,
        blockedWrapper: params.blockedWrapper,
    };
}
export function resolveDispatchWrapperTrustPlan(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH, platform = process.platform) {
    let current = argv;
    const wrappers = [];
    for (let depth = 0; depth < maxDepth; depth += 1) {
        const unwrap = unwrapKnownDispatchWrapperInvocation(current, platform);
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
        if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current, platform)) {
            return blockedDispatchWrapperPlan({
                argv: current,
                wrappers,
                blockedWrapper: unwrap.wrapper,
            });
        }
        current = unwrap.argv;
    }
    if (wrappers.length >= maxDepth) {
        const overflow = unwrapKnownDispatchWrapperInvocation(current, platform);
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
export function hasDispatchEnvManipulation(argv) {
    const unwrap = unwrapKnownDispatchWrapperInvocation(argv);
    return (unwrap.kind === "unwrapped" && unwrap.wrapper === "env" && envInvocationUsesModifiers(argv));
}
