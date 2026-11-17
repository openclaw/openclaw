import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";
import type {
  ControlUiBrowserDiscovery,
  ControlUiBrowserInstallation,
} from "./control-ui-browser.js";
import { resolveExecutableFromPathEnvAsync } from "./executable-path.js";

const BROWSERS = [
  { binary: "google-chrome", family: "chrome", name: "Chrome" },
  { binary: "google-chrome-stable", family: "chrome", name: "Chrome" },
  { binary: "firefox", family: "firefox", name: "Firefox" },
  { binary: "firefox-esr", family: "firefox", name: "Firefox" },
  { binary: "microsoft-edge", family: "edge", name: "Edge" },
  { binary: "microsoft-edge-stable", family: "edge", name: "Edge" },
  { binary: "chromium", family: "chrome", name: "Chromium" },
  { binary: "chromium-browser", family: "chrome", name: "Chromium" },
] as const;

/** Native desktop browsers only. WSL is kept on its Windows desktop opener by the caller. */
export async function discoverLinuxControlUiBrowsers(): Promise<ControlUiBrowserDiscovery> {
  // xdg-open honors BROWSER; desktop registration cannot identify that override reliably.
  if (process.env.BROWSER) {
    return { alternatives: [] };
  }
  const signal = AbortSignal.timeout(3_000);
  const run = (command: string, args: string[]) =>
    runExec(command, args, { timeoutMs: 1_000, signal, maxBuffer: 8192, logOutput: false });
  const defaultDesktop = await run("xdg-mime", ["query", "default", "x-scheme-handler/https"])
    .then((result) => result.stdout.trim())
    .catch(() => "");
  if (!/^[\w.-]+\.desktop$/.test(defaultDesktop)) {
    return { alternatives: [] };
  }
  const alternatives = (
    await Promise.all(
      BROWSERS.map(async (browser): Promise<ControlUiBrowserInstallation | undefined> => {
        const executable = await resolveExecutableFromPathEnvAsync(
          browser.binary,
          process.env.PATH ?? "",
          process.env,
          { useCache: false },
        );
        if (!executable || !path.isAbsolute(executable)) {
          return undefined;
        }
        try {
          const { stdout } = await run(executable, ["--version"]);
          const pattern =
            browser.family === "firefox"
              ? /^(?:Mozilla )?Firefox\s+(\d+(?:\.\d+)*)(?:esr)?(?:\s|$)/i
              : /^(?:Google Chrome(?: for Testing)?|Chromium|Microsoft Edge)\s+(\d+(?:\.\d+)*)(?:\s|$)/i;
          // Automation builds are deliberately not dashboard candidates.
          const version = stdout.includes("for Testing") ? "" : (stdout.match(pattern)?.[1] ?? "");
          return { family: browser.family, name: browser.name, version, command: [executable] };
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((browser) => browser !== undefined);
  const roots = [
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  ]
    .filter((root) => path.isAbsolute(root))
    .slice(0, 8);
  for (const root of roots) {
    let file;
    try {
      file = await fs.open(path.join(root, "applications", defaultDesktop), "r");
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead === buffer.length) {
        return { alternatives };
      }
      const section = buffer
        .toString("utf8", 0, bytesRead)
        .split(/^\[Desktop Entry\]\s*$/m)[1]
        ?.split(/^\[/m)[0];
      const exec = section?.match(/^Exec\s*=\s*(?:"([^"]+)"|(\S+))/m);
      const executable = exec?.[1] ?? exec?.[2];
      const defaultBrowser = alternatives.find(
        (browser) =>
          executable &&
          (path.isAbsolute(executable)
            ? executable === browser.command[0]
            : executable === path.basename(browser.command[0]!)),
      );
      return { defaultBrowser, alternatives };
    } catch {
      // Try the next standard XDG data root; never evaluate a desktop Exec line.
    } finally {
      await file?.close();
    }
  }
  return { alternatives };
}
