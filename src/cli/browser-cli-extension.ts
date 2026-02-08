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

export function resolveBundledExtensionRootDir(
  here = path.dirname(fileURLToPath(import.meta.url)),
) {
  // Strategy: walk up from the current file location until we find the package root
  // (directory containing package.json), then look for assets/chrome-extension there.
  let current = here;
  let packageRoot: string | null = null;

  // First pass: find openclaw package root
  // In workspace/monorepo scenarios, verify this is the openclaw package (not workspace root)
  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        // Accept if this is the openclaw package, or if no name field (dev build)
        if (!pkg.name || pkg.name === "openclaw") {
          packageRoot = current;
          break;
        }
        // Otherwise keep walking up (might be in a workspace)
      } catch {
        // Invalid package.json, keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // If we found package root, try assets/chrome-extension there
  if (packageRoot) {
    const candidate = path.join(packageRoot, "assets", "chrome-extension");
    if (hasManifest(candidate)) {
      return candidate;
    }
  }

  // Fallback: walk up from here looking for assets/chrome-extension directly
  current = here;
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

  // Last resort: relative path (for development builds)
  return path.resolve(here, "../../assets/chrome-extension");
}

function installedExtensionRootDir() {
  return path.join(STATE_DIR, "browser", "chrome-extension");
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
