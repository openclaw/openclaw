import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { MAX_DISPATCH_WRAPPER_DEPTH, hasDispatchEnvManipulation, unwrapKnownDispatchWrapperInvocation, } from "./dispatch-wrapper-resolution.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { POSIX_INLINE_COMMAND_FLAGS, POWERSHELL_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch, } from "./shell-inline-command.js";
const POSIX_SHELL_WRAPPER_NAMES = ["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"];
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"];
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"];
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"];
function withWindowsExeAliases(names) {
    const expanded = new Set();
    for (const name of names) {
        expanded.add(name);
        expanded.add(`${name}.exe`);
    }
    return Array.from(expanded);
}
export const POSIX_SHELL_WRAPPERS = new Set(POSIX_SHELL_WRAPPER_NAMES);
export const WINDOWS_CMD_WRAPPERS = new Set(withWindowsExeAliases(WINDOWS_CMD_WRAPPER_NAMES));
export const POWERSHELL_WRAPPERS = new Set(withWindowsExeAliases(POWERSHELL_WRAPPER_NAMES));
const POSIX_SHELL_WRAPPER_CANONICAL = new Set(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPER_CANONICAL = new Set(WINDOWS_CMD_WRAPPER_NAMES);
const POWERSHELL_WRAPPER_CANONICAL = new Set(POWERSHELL_WRAPPER_NAMES);
const SHELL_MULTIPLEXER_WRAPPER_CANONICAL = new Set(SHELL_MULTIPLEXER_WRAPPER_NAMES);
const SHELL_WRAPPER_CANONICAL = new Set([
    ...POSIX_SHELL_WRAPPER_NAMES,
    ...WINDOWS_CMD_WRAPPER_NAMES,
    ...POWERSHELL_WRAPPER_NAMES,
]);
const SHELL_WRAPPER_SPECS = [
    { kind: "posix", names: POSIX_SHELL_WRAPPER_CANONICAL },
    { kind: "cmd", names: WINDOWS_CMD_WRAPPER_CANONICAL },
    { kind: "powershell", names: POWERSHELL_WRAPPER_CANONICAL },
];
function resolveShellWrapperCandidate(params) {
    if (!isWithinDispatchClassificationDepth(params.depth)) {
        return null;
    }
    const token0 = params.argv[0]?.trim();
    if (!token0) {
        return null;
    }
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(params.argv);
    if (dispatchUnwrap.kind === "blocked") {
        return null;
    }
    if (dispatchUnwrap.kind === "unwrapped") {
        return resolveShellWrapperCandidate({
            ...params,
            argv: dispatchUnwrap.argv,
            depth: params.depth + 1,
            state: params.onDispatchUnwrap?.(params.state, params.argv) ?? params.state,
        });
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(params.argv);
    if (shellMultiplexerUnwrap.kind === "blocked") {
        return null;
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
        return resolveShellWrapperCandidate({
            ...params,
            argv: shellMultiplexerUnwrap.argv,
            depth: params.depth + 1,
        });
    }
    return { argv: params.argv, token0, state: params.state };
}
function resolveShellWrapperSpecAndArgvInternal(argv, depth) {
    const candidate = resolveShellWrapperCandidate({ argv, depth, state: null });
    if (!candidate) {
        return null;
    }
    const wrapper = findShellWrapperSpec(normalizeExecutableToken(candidate.token0));
    if (!wrapper) {
        return null;
    }
    const payload = extractShellWrapperPayload(candidate.argv, wrapper);
    if (!payload) {
        return null;
    }
    return { argv: candidate.argv, wrapper, payload };
}
function isWithinDispatchClassificationDepth(depth) {
    return depth <= MAX_DISPATCH_WRAPPER_DEPTH;
}
export function isShellWrapperExecutable(token) {
    return SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
function isShellWrapperInvocationInternal(argv, depth) {
    const candidate = resolveShellWrapperCandidate({ argv, depth, state: null });
    return candidate ? isShellWrapperExecutable(candidate.token0) : false;
}
export function isShellWrapperInvocation(argv) {
    return isShellWrapperInvocationInternal(argv, 0);
}
function normalizeRawCommand(rawCommand) {
    const trimmed = rawCommand?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}
function findShellWrapperSpec(baseExecutable) {
    for (const spec of SHELL_WRAPPER_SPECS) {
        if (spec.names.has(baseExecutable)) {
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
function extractPosixShellInlineCommand(argv) {
    return extractInlineCommandByFlags(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
}
function extractCmdInlineCommand(argv) {
    const idx = argv.findIndex((item) => {
        const token = normalizeLowercaseStringOrEmpty(item);
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
    return resolveInlineCommandMatch(argv, flags, options).command;
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
    throw new Error("Unsupported shell wrapper kind");
}
function hasEnvManipulationBeforeShellWrapperInternal(argv, depth, envManipulationSeen) {
    const candidate = resolveShellWrapperCandidate({
        argv,
        depth,
        state: envManipulationSeen,
        onDispatchUnwrap: (state, wrappedArgv) => state || hasDispatchEnvManipulation(wrappedArgv),
    });
    if (!candidate) {
        return false;
    }
    const wrapper = findShellWrapperSpec(normalizeExecutableToken(candidate.token0));
    if (!wrapper) {
        return false;
    }
    const payload = extractShellWrapperPayload(candidate.argv, wrapper);
    if (!payload) {
        return false;
    }
    return candidate.state;
}
export function hasEnvManipulationBeforeShellWrapper(argv) {
    return hasEnvManipulationBeforeShellWrapperInternal(argv, 0, false);
}
function extractShellWrapperCommandInternal(argv, rawCommand, depth) {
    const resolved = resolveShellWrapperSpecAndArgvInternal(argv, depth);
    if (!resolved) {
        return { isWrapper: false, command: null };
    }
    return { isWrapper: true, command: rawCommand ?? resolved.payload };
}
export function resolveShellWrapperTransportArgv(argv) {
    return resolveShellWrapperSpecAndArgvInternal(argv, 0)?.argv ?? null;
}
export function extractShellWrapperInlineCommand(argv) {
    const extracted = extractShellWrapperCommandInternal(argv, null, 0);
    return extracted.isWrapper ? extracted.command : null;
}
export function extractShellWrapperCommand(argv, rawCommand) {
    return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
}
