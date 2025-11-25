import { danger, info, success, warn, logVerbose, isVerbose } from "./globals.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
	runtime.log(info(message));
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
	runtime.log(warn(message));
}

export function logSuccess(
	message: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	runtime.log(success(message));
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
	runtime.error(danger(message));
}

export function logDebug(message: string) {
	// Verbose helper that respects global verbosity flag.
	if (isVerbose()) logVerbose(message);
}
