import { runCommandWithTimeout } from "../process/exec.js";
import { detectBinary } from "./detect-binary.js";
import { getWindowsSystem32ExePath } from "./windows-install-roots.js";
import { isWSL } from "./wsl.js";

type BrowserOpenCommand = {
  argv: string[] | null;
  reason?: string;
};

type BrowserOpenSupport = {
  ok: boolean;
  reason?: string;
};

type BrowserOpenEnvironment = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function normalizeBrowserOpenUrl(raw: string): string | null {
  const parsed = URL.parse(raw);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:" ? parsed.toString() : null;
}

/** Resolve the platform command used to open an HTTP(S) URL in a browser. */
export async function resolveBrowserOpenCommand(
  environment: BrowserOpenEnvironment = {},
): Promise<BrowserOpenCommand> {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  const isSsh = Boolean(env.SSH_CLIENT) || Boolean(env.SSH_TTY) || Boolean(env.SSH_CONNECTION);

  if (isSsh && !hasDisplay && platform !== "win32" && platform !== "darwin") {
    return { argv: null, reason: "ssh-no-display" };
  }

  if (platform === "win32") {
    const rundll32 = getWindowsSystem32ExePath("rundll32.exe");
    return {
      argv: [rundll32, "url.dll,FileProtocolHandler"],
    };
  }

  if (platform === "darwin") {
    const hasOpen = await detectBinary("open");
    return hasOpen ? { argv: ["open"] } : { argv: null, reason: "missing-open" };
  }

  if (platform === "linux") {
    const wsl = await isWSL(environment);
    if (!hasDisplay && !wsl) {
      return { argv: null, reason: "no-display" };
    }
    if (wsl) {
      const hasWslview = await detectBinary("wslview");
      if (hasWslview) {
        return { argv: ["wslview"] };
      }
      if (!hasDisplay) {
        return { argv: null, reason: "wsl-no-wslview" };
      }
    }
    const hasXdgOpen = await detectBinary("xdg-open");
    return hasXdgOpen ? { argv: ["xdg-open"] } : { argv: null, reason: "missing-xdg-open" };
  }

  return { argv: null, reason: "unsupported-platform" };
}

/** Report whether browser opening is currently available. */
export async function detectBrowserOpenSupport(
  environment: BrowserOpenEnvironment = {},
): Promise<BrowserOpenSupport> {
  const resolved = await resolveBrowserOpenCommand(environment);
  if (!resolved.argv) {
    return { ok: false, reason: resolved.reason };
  }
  return { ok: true };
}

/** Open a safe HTTP(S) URL in the user's browser when the platform supports it. */
export async function openUrl(url: string): Promise<boolean> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  const normalizedUrl = normalizeBrowserOpenUrl(url);
  if (!normalizedUrl) {
    return false;
  }
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) {
    return false;
  }
  const command = [...resolved.argv, normalizedUrl];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    return result.code === 0 && result.termination === "exit";
  } catch {
    return false;
  }
}
