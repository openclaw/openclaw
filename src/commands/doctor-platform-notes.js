import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
const execFileAsync = promisify(execFile);
function resolveHomeDir() {
    return process.env.HOME ?? os.homedir();
}
export async function noteMacLaunchAgentOverrides() {
    if (process.platform !== "darwin") {
        return;
    }
    const home = resolveHomeDir();
    const markerCandidates = [path.join(home, ".openclaw", "disable-launchagent")];
    const markerPath = markerCandidates.find((candidate) => fs.existsSync(candidate));
    if (!markerPath) {
        return;
    }
    const displayMarkerPath = shortenHomePath(markerPath);
    const lines = [
        `- LaunchAgent writes are disabled via ${displayMarkerPath}.`,
        "- To restore default behavior:",
        `  rm ${displayMarkerPath}`,
    ].filter((line) => Boolean(line));
    note(lines.join("\n"), "Gateway (macOS)");
}
async function launchctlGetenv(name) {
    try {
        const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
        const value = normalizeOptionalString(result.stdout ?? "") ?? "";
        return value.length > 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function hasConfigGatewayCreds(cfg) {
    const localPassword = cfg.gateway?.auth?.password;
    const remoteToken = cfg.gateway?.remote?.token;
    const remotePassword = cfg.gateway?.remote?.password;
    return (hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults) ||
        hasConfiguredSecretInput(localPassword, cfg.secrets?.defaults) ||
        hasConfiguredSecretInput(remoteToken, cfg.secrets?.defaults) ||
        hasConfiguredSecretInput(remotePassword, cfg.secrets?.defaults));
}
export async function noteMacLaunchctlGatewayEnvOverrides(cfg, deps) {
    const platform = deps?.platform ?? process.platform;
    if (platform !== "darwin") {
        return;
    }
    if (!hasConfigGatewayCreds(cfg)) {
        return;
    }
    const getenv = deps?.getenv ?? launchctlGetenv;
    const tokenEntries = [
        ["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")],
    ];
    const passwordEntries = [
        ["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")],
    ];
    const tokenEntry = tokenEntries.find(([, value]) => normalizeOptionalString(value));
    const passwordEntry = passwordEntries.find(([, value]) => normalizeOptionalString(value));
    const envToken = normalizeOptionalString(tokenEntry?.[1]) ?? "";
    const envPassword = normalizeOptionalString(passwordEntry?.[1]) ?? "";
    const envTokenKey = tokenEntry?.[0];
    const envPasswordKey = passwordEntry?.[0];
    if (!envToken && !envPassword) {
        return;
    }
    const lines = [
        "- launchctl environment overrides detected (can cause confusing unauthorized errors).",
        envToken && envTokenKey
            ? `- \`${envTokenKey}\` is set; it overrides config tokens.`
            : undefined,
        envPassword
            ? `- \`${envPasswordKey ?? "OPENCLAW_GATEWAY_PASSWORD"}\` is set; it overrides config passwords.`
            : undefined,
        "- Clear overrides and restart the app/gateway:",
        envTokenKey ? `  launchctl unsetenv ${envTokenKey}` : undefined,
        envPasswordKey ? `  launchctl unsetenv ${envPasswordKey}` : undefined,
    ].filter((line) => Boolean(line));
    (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
}
function isTruthyEnvValue(value) {
    return Boolean(normalizeOptionalString(value));
}
function isTmpCompileCachePath(cachePath) {
    const normalized = cachePath.trim().replace(/\/+$/, "");
    return (normalized === "/tmp" ||
        normalized.startsWith("/tmp/") ||
        normalized === "/private/tmp" ||
        normalized.startsWith("/private/tmp/"));
}
export function noteStartupOptimizationHints(env = process.env, deps) {
    const platform = deps?.platform ?? process.platform;
    if (platform === "win32") {
        return;
    }
    const arch = deps?.arch ?? os.arch();
    const totalMemBytes = deps?.totalMemBytes ?? os.totalmem();
    const isArmHost = arch === "arm" || arch === "arm64";
    const isLowMemoryLinux = platform === "linux" && totalMemBytes > 0 && totalMemBytes <= 8 * 1024 ** 3;
    const isStartupTuneTarget = platform === "linux" && (isArmHost || isLowMemoryLinux);
    if (!isStartupTuneTarget) {
        return;
    }
    const noteFn = deps?.noteFn ?? note;
    const compileCache = normalizeOptionalString(env.NODE_COMPILE_CACHE) ?? "";
    const disableCompileCache = normalizeOptionalString(env.NODE_DISABLE_COMPILE_CACHE) ?? "";
    const noRespawn = normalizeOptionalString(env.OPENCLAW_NO_RESPAWN) ?? "";
    const lines = [];
    if (!compileCache) {
        lines.push("- NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on small hosts (Pi/VM).");
    }
    else if (isTmpCompileCachePath(compileCache)) {
        lines.push("- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.");
    }
    if (isTruthyEnvValue(disableCompileCache)) {
        lines.push("- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.");
    }
    if (noRespawn !== "1") {
        lines.push("- OPENCLAW_NO_RESPAWN is not set to 1; set it to avoid extra startup overhead from self-respawn.");
    }
    if (lines.length === 0) {
        return;
    }
    const suggestions = [
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
        isTruthyEnvValue(disableCompileCache) ? "  unset NODE_DISABLE_COMPILE_CACHE" : undefined,
    ].filter((line) => Boolean(line));
    noteFn([...lines, ...suggestions].join("\n"), "Startup optimization");
}
