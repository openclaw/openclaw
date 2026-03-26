import { isRemoteEnvironment } from "../infra/remote-env.js";
import { isWSL } from "../infra/wsl.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { detectBinary } from "./setup-binary.js";

export { isRemoteEnvironment } from "../infra/remote-env.js";

function shouldSkipBrowserOpenInTests(): boolean {
  if (process.env.VITEST) {
    return true;
  }
  return process.env.NODE_ENV === "test";
}

type BrowserOpenCommand = {
  argv: string[] | null;
  command?: string;
  quoteUrl?: boolean;
};

async function resolveBrowserOpenCommand(): Promise<BrowserOpenCommand> {
  const platform = process.platform;
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const isSsh =
    Boolean(process.env.SSH_CLIENT) ||
    Boolean(process.env.SSH_TTY) ||
    Boolean(process.env.SSH_CONNECTION);

  if (isSsh && !hasDisplay && platform !== "win32") {
    return { argv: null };
  }

  if (platform === "win32") {
    return {
      argv: ["cmd", "/c", "start", ""],
      command: "cmd",
      quoteUrl: true,
    };
  }

  if (platform === "darwin") {
    const hasOpen = await detectBinary("open");
    return hasOpen ? { argv: ["open"], command: "open" } : { argv: null };
  }

  if (platform === "linux") {
    const wsl = await isWSL();
    if (!hasDisplay && !wsl) {
      return { argv: null };
    }
    if (wsl) {
      const hasWslview = await detectBinary("wslview");
      if (hasWslview) {
        return { argv: ["wslview"], command: "wslview" };
      }
      if (!hasDisplay) {
        return { argv: null };
      }
    }
    const hasXdgOpen = await detectBinary("xdg-open");
    return hasXdgOpen ? { argv: ["xdg-open"], command: "xdg-open" } : { argv: null };
  }

  return { argv: null };
}

export async function openUrl(url: string): Promise<boolean> {
  if (shouldSkipBrowserOpenInTests()) {
    return false;
  }
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) {
    return false;
  }
  const quoteUrl = resolved.quoteUrl === true;
  const command = [...resolved.argv];
  if (quoteUrl) {
    if (command.at(-1) === "") {
      command[command.length - 1] = '""';
    }
    command.push(`"${url}"`);
  } else {
    command.push(url);
  }
  try {
    await runCommandWithTimeout(command, {
      timeoutMs: 5_000,
      windowsVerbatimArguments: quoteUrl,
    });
    return true;
  } catch {
    return false;
  }
}
