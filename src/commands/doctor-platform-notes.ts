import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EasyHubConfig } from "../config/config.js";
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
  const markerCandidates = [path.join(home, ".easyhub", "disable-launchagent")];
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

function hasConfigGatewayCreds(cfg: EasyHubConfig): boolean {
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
  cfg: EasyHubConfig,
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
    ["MOLTBOT_GATEWAY_TOKEN", await getenv("MOLTBOT_GATEWAY_TOKEN")],
    ["MOLTBOT_GATEWAY_PASSWORD", await getenv("MOLTBOT_GATEWAY_PASSWORD")],
    ["EASYHUB_GATEWAY_TOKEN", await getenv("EASYHUB_GATEWAY_TOKEN")],
    ["EASYHUB_GATEWAY_PASSWORD", await getenv("EASYHUB_GATEWAY_PASSWORD")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  if (deprecatedLaunchctlEntries.length > 0) {
    const lines = [
      "- Deprecated launchctl environment variables detected (ignored).",
      ...deprecatedLaunchctlEntries.map(
        ([key]) =>
          `- \`${key}\` is set; use \`EASYHUB_${key.slice(key.indexOf("_") + 1)}\` instead.`,
      ),
    ];
    (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
  }

  const tokenEntries = [
    ["EASYHUB_GATEWAY_TOKEN", await getenv("EASYHUB_GATEWAY_TOKEN")],
  ] as const;
  const passwordEntries = [
    ["EASYHUB_GATEWAY_PASSWORD", await getenv("EASYHUB_GATEWAY_PASSWORD")],
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
      ? `- \`${envPasswordKey ?? "EASYHUB_GATEWAY_PASSWORD"}\` is set; it overrides config passwords.`
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
    .filter(
      ([key, value]) =>
        (key.startsWith("MOLTBOT_") || key.startsWith("EASYHUB_")) && value?.trim(),
    )
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- Deprecated legacy environment variables detected (ignored).",
    "- Use EASYHUB_* equivalents instead:",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> EASYHUB_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "Environment");
}
