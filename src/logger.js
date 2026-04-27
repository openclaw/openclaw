import { isVerbose } from "./global-state.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime } from "./runtime.js";
import { theme } from "./terminal/theme.js";
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
function splitSubsystem(message) {
    const match = message.match(subsystemPrefixRe);
    if (!match) {
        return null;
    }
    const [, subsystem, rest] = match;
    return { subsystem, rest };
}
function logWithSubsystem(params) {
    const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
    if (parsed) {
        createSubsystemLogger(parsed.subsystem)[params.subsystemMethod](parsed.rest);
        return;
    }
    params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
    getLogger()[params.loggerMethod](params.message);
}
const info = theme.info;
const warn = theme.warn;
const success = theme.success;
const danger = theme.error;
export function logInfo(message, runtime = defaultRuntime) {
    logWithSubsystem({
        message,
        runtime,
        runtimeMethod: "log",
        runtimeFormatter: info,
        loggerMethod: "info",
        subsystemMethod: "info",
    });
}
export function logWarn(message, runtime = defaultRuntime) {
    logWithSubsystem({
        message,
        runtime,
        runtimeMethod: "log",
        runtimeFormatter: warn,
        loggerMethod: "warn",
        subsystemMethod: "warn",
    });
}
export function logSuccess(message, runtime = defaultRuntime) {
    logWithSubsystem({
        message,
        runtime,
        runtimeMethod: "log",
        runtimeFormatter: success,
        loggerMethod: "info",
        subsystemMethod: "info",
    });
}
export function logError(message, runtime = defaultRuntime) {
    logWithSubsystem({
        message,
        runtime,
        runtimeMethod: "error",
        runtimeFormatter: danger,
        loggerMethod: "error",
        subsystemMethod: "error",
    });
}
export function logDebug(message) {
    // Always emit to file logger (level-filtered); console only when verbose.
    getLogger().debug(message);
    if (isVerbose()) {
        console.log(theme.muted(message));
    }
}
