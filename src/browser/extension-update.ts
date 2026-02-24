import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import { movePathToTrash } from "./trash.js";

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

export function installedExtensionRootDir(stateDir?: string) {
  return path.join(stateDir ?? resolveStateDir(), "browser", "chrome-extension");
}

export function hasManifest(dir: string) {
  return fs.existsSync(path.join(dir, "manifest.json"));
}

const BUNDLE_HASH_FILE = ".bundle-hash";

/** Hash top-level files in the extension dir (deterministic, ignores subdirs like icons/). */
export function computeExtensionHash(dir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const hash = crypto.createHash("sha256");
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name !== BUNDLE_HASH_FILE) {
      hash.update(entry.name);
      hash.update(fs.readFileSync(path.join(dir, entry.name)));
    }
  }
  return hash.digest("hex").slice(0, 16);
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

  const bundleHash = computeExtensionHash(src);
  if (bundleHash) {
    fs.writeFileSync(path.join(dest, BUNDLE_HASH_FILE), bundleHash);
  }

  return { path: dest };
}

/**
 * If the extension was previously installed and the bundled version has changed,
 * silently re-install and return true so the caller can notify the user.
 */
export async function ensureExtensionUpToDate(opts?: {
  stateDir?: string;
  sourceDir?: string;
}): Promise<boolean> {
  const stateDir = opts?.stateDir ?? resolveStateDir();
  const installed = path.join(stateDir, "browser", "chrome-extension");
  if (!hasManifest(installed)) {
    return false;
  }

  const bundled = opts?.sourceDir ?? resolveBundledExtensionRootDir();
  if (!hasManifest(bundled)) {
    return false;
  }

  const bundledHash = computeExtensionHash(bundled);
  if (!bundledHash) {
    return false;
  }

  let storedHash = "";
  try {
    storedHash = fs.readFileSync(path.join(installed, BUNDLE_HASH_FILE), "utf8").trim();
  } catch {
    // No hash file → pre-hash install; treat as stale.
  }

  if (storedHash === bundledHash) {
    return false;
  }

  await installChromeExtension({ stateDir, sourceDir: opts?.sourceDir });
  return true;
}
