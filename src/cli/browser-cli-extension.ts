import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { movePathToTrash } from "../browser/trash.js";
import { resolveStateDir } from "../config/paths.js";
import { danger, info } from "../globals.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import { callBrowserRequest } from "./browser-cli-shared.js";
import { formatCliCommand } from "./command-format.js";

export function resolveBundledExtensionRootDir(
  here = path.dirname(fileURLToPath(import.meta.url)),
) {
  let current = here;
  while (true) {
    const candidate = path.join(current, "assets", "chrome-extension");
    if (hasManifest(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(here, "../../assets/chrome-extension");
}

function installedExtensionRootDir() {
  return path.join(resolveStateDir(), "browser", "chrome-extension");
}

function hasManifest(dir: string) {
  return fs.existsSync(path.join(dir, "manifest.json"));
}

export async function installChromeExtension(opts?: {
  stateDir?: string;
  sourceDir?: string;
}): Promise<{ path: string }> {
  const src = opts?.sourceDir ?? resolveBundledExtensionRootDir();
  if (!hasManifest(src)) {
    throw new Error("Bundled Chrome extension is missing. Reinstall OpenClaw and try again.");
  }

  const stateDir = opts?.stateDir ?? resolveStateDir();
  const dest = path.join(stateDir, "browser", "chrome-extension");
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    await movePathToTrash(dest).catch(() => {
      const backup = `${dest}.old-${Date.now()}`;
      fs.renameSync(dest, backup);
    });
  }

  await fs.promises.cp(src, dest, { recursive: true });
  if (!hasManifest(dest)) {
    throw new Error("Chrome extension install failed (manifest.json missing). Try again.");
  }

  return { path: dest };
}

export function registerBrowserExtensionCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const ext = browser.command("extension").description("Chrome extension helpers");

  ext
    .command("install")
    .description("Install the Chrome extension to a stable local path")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      let installed: { path: string };
      try {
        installed = await installChromeExtension();
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
        return;
      }

      if (parent?.json) {
        defaultRuntime.log(JSON.stringify({ ok: true, path: installed.path }, null, 2));
        return;
      }
      const displayPath = shortenHomePath(installed.path);
      defaultRuntime.log(displayPath);
      const copied = await copyToClipboard(installed.path).catch(() => false);
      defaultRuntime.error(
        info(
          [
            copied ? "Copied to clipboard." : "Copy to clipboard unavailable.",
            "Next:",
            `- Chrome → chrome://extensions → enable “Developer mode”`,
            `- “Load unpacked” → select: ${displayPath}`,
            `- Pin “OpenClaw Browser Relay”, then click it on the tab (badge shows ON)`,
            "",
            `${theme.muted("Docs:")} ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`,
          ].join("\n"),
        ),
      );
    });

  ext
    .command("check")
    .description("Check browser relay connectivity and connected extensions")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      let status: { connected: boolean; connections: { id: string; name: string }[] };
      try {
        status = await callBrowserRequest(parent, {
          method: "GET",
          path: "/extension/status",
          query: parent.browserProfile ? { profile: parent.browserProfile } : undefined,
        });
      } catch (err) {
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: false, error: String(err) }, null, 2));
        } else {
          defaultRuntime.error(danger(`Failed to reach relay: ${String(err)}`));
          defaultRuntime.error(
            info(
              `Hint: Ensure the SSH tunnel is open (port 18792) and the OpenClaw gateway is running.`,
            ),
          );
        }
        defaultRuntime.exit(1);
        return;
      }

      if (parent?.json) {
        defaultRuntime.log(JSON.stringify({ ok: true, ...status }, null, 2));
        return;
      }

      if (!status.connected) {
        defaultRuntime.log(
          theme.warn("Relay server is OK, but no Chrome extensions are connected."),
        );
        defaultRuntime.log(
          info("Action: Go to Chrome, click the OpenClaw extension icon (badge should show ON)."),
        );
        return;
      }

      defaultRuntime.log(theme.success("Relay server is connected."));
      defaultRuntime.log(`${theme.heading("Connected devices:")} ${status.connections.length}`);
      for (const conn of status.connections) {
        defaultRuntime.log(
          `${theme.muted("-")} ${conn.name} ${theme.muted(`(${conn.id.slice(0, 8)})`)}`,
        );
      }
    });

  ext
    .command("path")
    .description("Print the path to the installed Chrome extension (load unpacked)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const dir = installedExtensionRootDir();
      if (!hasManifest(dir)) {
        defaultRuntime.error(
          danger(
            [
              `Chrome extension is not installed. Run: "${formatCliCommand("openclaw browser extension install")}"`,
              `Docs: ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`,
            ].join("\n"),
          ),
        );
        defaultRuntime.exit(1);
      }
      if (parent?.json) {
        defaultRuntime.log(JSON.stringify({ path: dir }, null, 2));
        return;
      }
      const displayPath = shortenHomePath(dir);
      defaultRuntime.log(displayPath);
      const copied = await copyToClipboard(dir).catch(() => false);
      if (copied) {
        defaultRuntime.error(info("Copied to clipboard."));
      }
    });
}
