import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(): string {
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
  ].filter((line): line is string => Boolean(line));
  note(lines.join("\n"), "Gateway (macOS)");
}

async function launchctlGetenv(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
    const value = String(result.stdout ?? "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasConfigGatewayCreds(cfg: OpenClawConfig): boolean {
  const localToken =
    typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway?.auth?.token.trim() : "";
  const localPassword =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway?.auth?.password.trim() : "";
  const remoteToken =
    typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway?.remote?.token.trim() : "";
  const remotePassword =
    typeof cfg.gateway?.remote?.password === "string" ? cfg.gateway?.remote?.password.trim() : "";
  return Boolean(localToken || localPassword || remoteToken || remotePassword);
}

export async function noteMacLaunchctlGatewayEnvOverrides(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return;
  }
  if (!hasConfigGatewayCreds(cfg)) {
    return;
  }

  const getenv = deps?.getenv ?? launchctlGetenv;
  const deprecatedLaunchctlEntries = [
    ["CLAWDBOT_GATEWAY_TOKEN", await getenv("CLAWDBOT_GATEWAY_TOKEN")],
    ["CLAWDBOT_GATEWAY_PASSWORD", await getenv("CLAWDBOT_GATEWAY_PASSWORD")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  if (deprecatedLaunchctlEntries.length > 0) {
    const lines = [
      "- Deprecated launchctl environment variables detected (ignored).",
      ...deprecatedLaunchctlEntries.map(
        ([key]) =>
          `- \`${key}\` is set; use \`OPENCLAW_${key.slice(key.indexOf("_") + 1)}\` instead.`,
      ),
    ];
    (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
  }

  const tokenEntries = [
    ["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")],
  ] as const;
  const passwordEntries = [
    ["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")],
  ] as const;
  const tokenEntry = tokenEntries.find(([, value]) => value?.trim());
  const passwordEntry = passwordEntries.find(([, value]) => value?.trim());
  const envToken = tokenEntry?.[1]?.trim() ?? "";
  const envPassword = passwordEntry?.[1]?.trim() ?? "";
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
  ].filter((line): line is string => Boolean(line));

  (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
}

export function noteDeprecatedLegacyEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { noteFn?: typeof note },
) {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("CLAWDBOT_") && value?.trim())
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- Deprecated legacy environment variables detected (ignored).",
    "- Use OPENCLAW_* equivalents instead:",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> OPENCLAW_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "Environment");
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTmpCompileCachePath(cachePath: string): boolean {
  const normalized = cachePath.trim().replace(/\/+$/, "");
  return (
    normalized === "/tmp" ||
    normalized.startsWith("/tmp/") ||
    normalized === "/private/tmp" ||
    normalized.startsWith("/private/tmp/")
  );
}

export function noteStartupOptimizationHints(
  env: NodeJS.ProcessEnv = process.env,
  deps?: {
    platform?: NodeJS.Platform;
    arch?: string;
    totalMemBytes?: number;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform === "win32") {
    return;
  }
  const arch = deps?.arch ?? os.arch();
  const totalMemBytes = deps?.totalMemBytes ?? os.totalmem();
  const isArmHost = arch === "arm" || arch === "arm64";
  const isLowMemoryLinux =
    platform === "linux" && totalMemBytes > 0 && totalMemBytes <= 8 * 1024 ** 3;
  const isStartupTuneTarget = platform === "linux" && (isArmHost || isLowMemoryLinux);
  if (!isStartupTuneTarget) {
    return;
  }

  const noteFn = deps?.noteFn ?? note;
  const compileCache = env.NODE_COMPILE_CACHE?.trim() ?? "";
  const disableCompileCache = env.NODE_DISABLE_COMPILE_CACHE?.trim() ?? "";
  const noRespawn = env.OPENCLAW_NO_RESPAWN?.trim() ?? "";
  const lines: string[] = [];

  if (!compileCache) {
    lines.push(
      "- NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on small hosts (Pi/VM).",
    );
  } else if (isTmpCompileCachePath(compileCache)) {
    lines.push(
      "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
    );
  }

  if (isTruthyEnvValue(disableCompileCache)) {
    lines.push("- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.");
  }

  if (noRespawn !== "1") {
    lines.push(
      "- OPENCLAW_NO_RESPAWN is not set to 1; set it to avoid extra startup overhead from self-respawn.",
    );
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
  ].filter((line): line is string => Boolean(line));

  noteFn([...lines, ...suggestions].join("\n"), "Startup optimization");
}
