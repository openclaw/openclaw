import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCommandWithTimeout } from "../process/exec.js";
import { detectBinary } from "./detect-binary.js";
import { getWindowsSystem32ExePath } from "./windows-install-roots.js";
import { isWSL } from "./wsl.js";

/** Resolve the platform command used to open an HTTP(S) URL in a browser. */
async function resolveBrowserOpenCommand(): Promise<string[] | null> {
  const platform = process.platform;
  const env = process.env;
  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  const isSsh = Boolean(env.SSH_CLIENT) || Boolean(env.SSH_TTY) || Boolean(env.SSH_CONNECTION);

  if (isSsh && !hasDisplay && platform !== "win32" && platform !== "darwin") {
    return null;
  }

  if (platform === "win32") {
    const rundll32 = getWindowsSystem32ExePath("rundll32.exe");
    return [rundll32, "url.dll,FileProtocolHandler"];
  }

  if (platform !== "darwin" && platform !== "linux") {
    return null;
  }

  if (platform === "linux") {
    const wsl = await isWSL();
    if (!hasDisplay && !wsl) {
      return null;
    }
    if (wsl) {
      const hasWslview = await detectBinary("wslview");
      if (hasWslview) {
        return ["wslview"];
      }
      if (!hasDisplay) {
        return null;
      }
    }
  }
  const command = platform === "darwin" ? "open" : "xdg-open";
  return (await detectBinary(command)) ? [command] : null;
}

/** Report whether browser opening is currently available. */
export async function detectBrowserOpenSupport(): Promise<{ ok: boolean }> {
  return { ok: Boolean(await resolveBrowserOpenCommand()) };
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
  const argv = await resolveBrowserOpenCommand();
  if (!argv) {
    return false;
  }
  const command = [...argv, normalizedPath];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    return result.code === 0 && result.termination === "exit";
  } catch {
    return false;
  }
}
