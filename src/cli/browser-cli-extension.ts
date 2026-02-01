import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { movePathToTrash } from "../browser/trash.js";
import { STATE_DIR } from "../config/paths.js";
import { danger, info } from "../globals.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

function workspaceExtensionSourceDir() {
  return path.join(STATE_DIR, "browser", "chrome-extension-source");
}

function installedExtensionRootDir() {
  return path.join(STATE_DIR, "browser", "chrome-extension");
}

function hasManifest(dir: string) {
  return fs.existsSync(path.join(dir, "manifest.json"));
}

async function ensureExtensionSourceInWorkspace(): Promise<string> {
  const workspaceSourceDir = workspaceExtensionSourceDir();

  // If already copied and valid, return it
  if (hasManifest(workspaceSourceDir)) {
    return workspaceSourceDir;
  }

  // Find the source assets - try multiple possible locations
  const possibleSources = [
    // Relative to compiled code location (current approach)
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/chrome-extension"),
    // Relative to project root when running from source
    path.resolve(process.cwd(), "assets/chrome-extension"),
    // In case we're in a subdirectory
    path.resolve(process.cwd(), "../assets/chrome-extension"),
  ];

  let foundSource: string | null = null;
  for (const candidate of possibleSources) {
    if (hasManifest(candidate)) {
      foundSource = candidate;
      break;
    }
  }

  if (!foundSource) {
    throw new Error(
      "Chrome extension source assets not found. Ensure you're running from a complete OpenClaw installation.",
    );
  }

  // Copy source assets to workspace
  fs.mkdirSync(path.dirname(workspaceSourceDir), { recursive: true });
  if (fs.existsSync(workspaceSourceDir)) {
    await fs.promises.rm(workspaceSourceDir, { recursive: true, force: true });
  }

  await fs.promises.cp(foundSource, workspaceSourceDir, { recursive: true });

  if (!hasManifest(workspaceSourceDir)) {
    throw new Error("Failed to copy Chrome extension source to workspace.");
  }

  return workspaceSourceDir;
}

export async function installChromeExtension(opts?: {
  stateDir?: string;
  sourceDir?: string;
}): Promise<{ path: string }> {
  // Use provided source directory or find/copy assets to workspace
  const src = opts?.sourceDir ?? (await ensureExtensionSourceInWorkspace());

  const stateDir = opts?.stateDir ?? STATE_DIR;
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
  parentOpts: (cmd: Command) => { json?: boolean },
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
