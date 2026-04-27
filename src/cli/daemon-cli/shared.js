import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayLaunchAgentLabel, resolveGatewaySystemdServiceName, resolveGatewayWindowsTaskName, } from "../../daemon/constants.js";
import { resolveDaemonContainerContext } from "../../daemon/container-context.js";
import { formatRuntimeStatus } from "../../daemon/runtime-format.js";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints, } from "../../daemon/runtime-hints.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";
import { createDaemonActionContext } from "./response.js";
export { formatRuntimeStatus };
export { parsePort };
export { resolveDaemonContainerContext };
export function createDaemonInstallActionContext(jsonFlag) {
    const json = Boolean(jsonFlag);
    return {
        json,
        ...createDaemonActionContext({ action: "install", json }),
    };
}
export function failIfNixDaemonInstallMode(fail, env = process.env) {
    if (!resolveIsNixMode(env)) {
        return false;
    }
    fail("Nix mode detected; service install is disabled.");
    return true;
}
export function createCliStatusTextStyles() {
    const rich = isRich();
    return {
        rich,
        label: (value) => colorize(rich, theme.muted, value),
        accent: (value) => colorize(rich, theme.accent, value),
        infoText: (value) => colorize(rich, theme.info, value),
        okText: (value) => colorize(rich, theme.success, value),
        warnText: (value) => colorize(rich, theme.warn, value),
        errorText: (value) => colorize(rich, theme.error, value),
    };
}
export function resolveRuntimeStatusColor(status) {
    const runtimeStatus = status ?? "unknown";
    return runtimeStatus === "running"
        ? theme.success
        : runtimeStatus === "stopped"
            ? theme.error
            : runtimeStatus === "unknown"
                ? theme.muted
                : theme.warn;
}
export function parsePortFromArgs(programArguments) {
    if (!programArguments?.length) {
        return null;
    }
    for (let i = 0; i < programArguments.length; i += 1) {
        const arg = programArguments[i];
        if (arg === "--port") {
            const next = programArguments[i + 1];
            const parsed = parsePort(next);
            if (parsed) {
                return parsed;
            }
        }
        if (arg?.startsWith("--port=")) {
            const parsed = parsePort(arg.split("=", 2)[1]);
            if (parsed) {
                return parsed;
            }
        }
    }
    return null;
}
export function pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost) {
    if (bindMode === "custom" && customBindHost?.trim()) {
        return customBindHost.trim();
    }
    if (bindMode === "tailnet") {
        return tailnetIPv4 ?? "127.0.0.1";
    }
    if (bindMode === "lan") {
        // Same as call.ts: self-connections should always target loopback.
        // bind=lan controls which interfaces the server listens on (0.0.0.0),
        // but co-located CLI probes should connect via 127.0.0.1.
        return "127.0.0.1";
    }
    return "127.0.0.1";
}
const SAFE_DAEMON_ENV_KEYS = [
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_NIX_MODE",
];
export function filterDaemonEnv(env) {
    if (!env) {
        return {};
    }
    const filtered = {};
    for (const key of SAFE_DAEMON_ENV_KEYS) {
        const value = env[key];
        if (!value?.trim()) {
            continue;
        }
        filtered[key] = value.trim();
    }
    return filtered;
}
export function safeDaemonEnv(env) {
    const filtered = filterDaemonEnv(env);
    return Object.entries(filtered).map(([key, value]) => `${key}=${value}`);
}
export function normalizeListenerAddress(raw) {
    let value = raw.trim();
    if (!value) {
        return value;
    }
    value = value.replace(/^TCP\s+/i, "");
    value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
    return value.trim();
}
export function renderRuntimeHints(runtime, env = process.env, logFile) {
    if (!runtime) {
        return [];
    }
    const hints = [];
    const fileLog = logFile ?? null;
    if (runtime.missingUnit) {
        hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
        if (fileLog) {
            hints.push(`File logs: ${fileLog}`);
        }
        return hints;
    }
    if (runtime.status === "stopped") {
        if (fileLog) {
            hints.push(`File logs: ${fileLog}`);
        }
        hints.push(...buildPlatformRuntimeLogHints({
            env,
            systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
            windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE),
        }));
    }
    return hints;
}
export function renderGatewayServiceStartHints(env = process.env) {
    const profile = env.OPENCLAW_PROFILE;
    const container = resolveDaemonContainerContext(env);
    const hints = buildPlatformServiceStartHints({
        installCommand: formatCliCommand("openclaw gateway install", env),
        startCommand: formatCliCommand("openclaw gateway", env),
        launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
        systemdServiceName: resolveGatewaySystemdServiceName(profile),
        windowsTaskName: resolveGatewayWindowsTaskName(profile),
    });
    if (!container) {
        return hints;
    }
    return [`Restart the container or the service that manages it for ${container}.`];
}
export function filterContainerGenericHints(hints, env = process.env) {
    if (!resolveDaemonContainerContext(env)) {
        return hints;
    }
    return hints.filter((hint) => !hint.includes("If you're in a container, run the gateway in the foreground instead of") &&
        !hint.includes("systemd user services are unavailable; install/enable systemd"));
}
