import type { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "../browser/chrome.executables.js";
import { loadConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { danger, info } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { installChromeExtension } from "./browser-cli-extension.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import { formatCliCommand } from "./command-format.js";

const RELAY_LAUNCH_PATH = "/extension/launch";
const RELAY_LAUNCH_HOST = "127.0.0.1";
const RELAY_PROFILE_FALLBACK = "chrome";

function buildRelayLaunchUrl(port: number, targetUrl?: string) {
  const base = `http://${RELAY_LAUNCH_HOST}:${port}${RELAY_LAUNCH_PATH}`;
  const trimmed = targetUrl?.trim();
  if (!trimmed) {
    return `${base}?url=about:blank`;
  }
  const params = new URLSearchParams({ url: trimmed });
  return `${base}?${params.toString()}`;
}

function resolveRelayProfileName(resolved: ReturnType<typeof resolveBrowserConfig>, requested?: string) {
  if (requested?.trim()) {
    return requested.trim();
  }
  if (resolved.profiles[RELAY_PROFILE_FALLBACK]) {
    return RELAY_PROFILE_FALLBACK;
  }
  return resolved.defaultProfile;
}

function resolveRelayUserDataDir(profileName: string) {
  return path.join(STATE_DIR, "browser", "relay", profileName);
}

export function registerBrowserRelayCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const relay = browser.command("relay").description("Chrome extension relay helpers");

  relay
    .command("launch")
    .description("Launch Chrome with the OpenClaw Browser Relay extension attached")
    .argument("[url]", "Optional URL to open (default: blank tab)")
    .action(async (url, cmd) => {
      const parent = parentOpts(cmd);
      const config = loadConfig();
      const resolved = resolveBrowserConfig(config.browser, config);
      const profileName = resolveRelayProfileName(resolved, parent?.browserProfile);
      const profile = resolveProfile(resolved, profileName);

      if (!profile) {
        defaultRuntime.error(
          danger(
            `Browser profile "${profileName}" not found. Try: "${formatCliCommand("openclaw browser profiles")}"`,
          ),
        );
        defaultRuntime.exit(1);
      }

      if (profile.driver !== "extension") {
        defaultRuntime.error(
          danger(
            `Browser profile "${profile.name}" is not an extension relay profile. Set driver=extension or use the "chrome" profile.`,
          ),
        );
        defaultRuntime.exit(1);
      }

      if (!profile.cdpIsLoopback) {
        defaultRuntime.error(
          danger(
            `Browser profile "${profile.name}" uses a remote relay (${profile.cdpUrl}). Relay launch requires a loopback cdpUrl.`,
          ),
        );
        defaultRuntime.exit(1);
      }

      let relayServerStarted = false;
      let relayServerError: string | null = null;
      try {
        await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/start",
            query: { profile: profile.name },
          },
          { timeoutMs: 15000 },
        );
        relayServerStarted = true;
      } catch (err) {
        relayServerError = err instanceof Error ? err.message : String(err);
        defaultRuntime.log(
          danger(
            `Could not start the relay server via Gateway (${relayServerError}). Launching Chrome anyway; auto-attach may fail if the relay isn't running.`,
          ),
        );
      }

      const launchUrl = buildRelayLaunchUrl(profile.cdpPort, typeof url === "string" ? url : "");

      let installed: { path: string };
      try {
        installed = await installChromeExtension();
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }

      let exe: BrowserExecutable | null = null;
      try {
        exe = resolveBrowserExecutableForPlatform(resolved, process.platform);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }

      if (!exe) {
        defaultRuntime.error(
          danger(
            "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
          ),
        );
        defaultRuntime.exit(1);
      }

      const userDataDir = resolveRelayUserDataDir(profile.name);
      fs.mkdirSync(userDataDir, { recursive: true });

      const args: string[] = [
        `--user-data-dir=${userDataDir}`,
        `--load-extension=${installed.path}`,
        `--disable-extensions-except=${installed.path}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-features=Translate,MediaRouter",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--password-store=basic",
        "--new-window",
        launchUrl,
      ];

      const proc = spawn(exe.path, args, {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          HOME: os.homedir(),
        },
      });
      proc.unref();

      if (parent?.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              ok: true,
              pid: proc.pid ?? null,
              executable: exe.path,
              userDataDir,
              extensionPath: installed.path,
              launchUrl,
              relayServerStarted,
              relayServerError,
            },
            null,
            2,
          ),
        );
        return;
      }

      defaultRuntime.log(
        info(
          [
            `Launching ${exe.kind} with OpenClaw Browser Relay...`,
            `Profile: ${profile.name}`,
            `Relay server: ${relayServerStarted ? "started" : "not started"}`,
            `User data dir: ${shortenHomePath(userDataDir)}`,
            `Extension path: ${shortenHomePath(installed.path)}`,
          ].join("\n"),
        ),
      );
    });
}
