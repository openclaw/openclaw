import fs from "node:fs/promises";
import { runExec } from "../process/exec.js";
import {
  estimateControlUiBrowserSupport,
  type ControlUiBrowserFamily,
} from "../shared/control-ui-browser-requirements.js";
import type { BrowserOpenOptions } from "./browser-open.js";
import { discoverLinuxControlUiBrowsers } from "./control-ui-browser-linux.js";
import { discoverMacControlUiBrowsers } from "./control-ui-browser-macos.js";
import { discoverWindowsControlUiBrowsers } from "./control-ui-browser-windows.js";
import { isRemoteEnvironment } from "./remote-env.js";
import { isWSL } from "./wsl.js";

export type ControlUiBrowserInstallation = {
  family: ControlUiBrowserFamily;
  /** Fixed display name supplied by the platform adapter, never raw OS output. */
  name: string;
  version: string;
  /** Browser application only: no automation profiles, URL placeholders, or credentials. */
  command: string[];
};

export type ControlUiBrowserDiscovery = {
  defaultBrowser?: ControlUiBrowserInstallation;
  /** Already ordered deterministically by the platform adapter. */
  alternatives: ControlUiBrowserInstallation[];
  headless?: boolean;
};

export type ControlUiBrowserChoice = {
  canOpen: boolean;
  openOptions?: BrowserOpenOptions;
  notice?: string;
};

/** Select only for the Control UI; OAuth and other generic browser opens stay unchanged. */
export async function resolveControlUiBrowser(): Promise<ControlUiBrowserChoice> {
  const wsl = process.platform === "linux" && (await isWSL());
  const remote = isRemoteEnvironment({ wsl });
  if (
    (remote && process.platform !== "darwin") ||
    process.env.SESSIONNAME?.toLowerCase() === "services"
  ) {
    return { canOpen: false };
  }
  // WSL's opener belongs to the Windows desktop, not the Linux browser inventory.
  if (wsl) {
    return { canOpen: true };
  }
  let discovery: ControlUiBrowserDiscovery;
  try {
    if (process.platform === "darwin") {
      // A local CLI without a logged-in console must not open another user's desktop.
      const console = await fs.stat("/dev/console").catch(() => undefined);
      if (!console || console.uid === 0 || console.uid !== process.getuid?.()) {
        return { canOpen: false };
      }
      if (remote) {
        if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
          return { canOpen: false };
        }
        // #67088/#85340: local Mac terminals can inherit stale SSH_* variables.
        // Require the current GUI bootstrap, not SSH env alone or console UID
        // alone: an actual SSH session can belong to that same console user.
        const localGuiSession = await runExec("/bin/launchctl", ["managername"], {
          timeoutMs: 1_000,
          maxBuffer: 256,
          logOutput: false,
        }).then(
          ({ stdout }) => stdout.trim() === "Aqua",
          () => false,
        );
        if (!localGuiSession) {
          return { canOpen: false };
        }
      }
      discovery = await discoverMacControlUiBrowsers();
    } else if (process.platform === "win32") {
      discovery = await discoverWindowsControlUiBrowsers();
    } else if (process.platform === "linux") {
      discovery = await discoverLinuxControlUiBrowsers();
    } else {
      return { canOpen: true };
    }
  } catch {
    // Unavailable discovery is not evidence of an unsupported browser.
    return { canOpen: true };
  }
  if (discovery.headless) {
    return { canOpen: false };
  }
  const current = discovery.defaultBrowser;
  if (
    !current ||
    estimateControlUiBrowserSupport(current.family, current.version) !== "unsupported"
  ) {
    return { canOpen: true };
  }
  const alternative = discovery.alternatives.find(
    (browser) => estimateControlUiBrowserSupport(browser.family, browser.version) === "compatible",
  );
  if (!alternative) {
    return {
      canOpen: false,
      notice:
        "Your default browser isn’t supported. No compatible installed browser was found. Use an up-to-date Safari, Chrome, Edge, or Firefox, or stay in the terminal with `openclaw tui`. Run `openclaw dashboard` again for a fresh pairing link.",
    };
  }
  return {
    canOpen: true,
    openOptions: { browserCommand: alternative.command },
    notice: `Your default browser isn’t supported. Opening OpenClaw in ${alternative.name} for this session.`,
  };
}
