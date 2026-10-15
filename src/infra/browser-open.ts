import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Resolve the platform command used to open an HTTP(S) URL in a browser. */
async function resolveBrowserOpenCommand(
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

  if (platform !== "darwin" && platform !== "linux") {
    return { argv: null, reason: "unsupported-platform" };
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
  }
  const command = platform === "darwin" ? "open" : "xdg-open";
  return (await detectBinary(command))
    ? { argv: [command] }
    : { argv: null, reason: `missing-${command}` };
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
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") {
    return false;
  }
  const normalizedUrl = parsed.toString();
  return await openBrowserPath(normalizedUrl);
}

/**
 * Open a local file in the user's browser when the platform supports it.
 *
 * Unlike {@link openUrl}, this accepts a `file://` path for private browser
 * handoffs: the path contains no credential, so passing it as an opener
 * argument does not expose secret material through process command lines.
 * The target file itself is the caller's responsibility (for example a
 * mode-0600 document inside a mode-0700 directory).
 */
export async function openLocalFile(filePath: string): Promise<boolean> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  // Path-only seam: accept only a native absolute filesystem path (POSIX
  // `/tmp/...` or Windows `C:\...`). URL-shaped strings such as
  // `http://host/#token=...` are never absolute paths, so a caller cannot
  // smuggle a credential URL through this function into opener argv.
  // Checking the path form first also keeps Windows drive letters from being
  // misread as URL schemes.
  const windows = process.platform === "win32";
  const platformPath = windows ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(filePath)) {
    return false;
  }
  const normalizedPath = pathToFileURL(platformPath.resolve(filePath), { windows }).toString();
  return await openBrowserPath(normalizedPath);
}

async function openBrowserPath(normalizedPath: string): Promise<boolean> {
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) {
    return false;
  }
  const command = [...resolved.argv, normalizedPath];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    return result.code === 0 && result.termination === "exit";
  } catch {
    return false;
  }
}
