import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";

/**
 * Sync bundled cli-scripts from the package root to ~/.openclaw/scripts/.
 * Called once at gateway startup so agents always find the scripts at a fixed path.
 */
export async function syncCliScripts(): Promise<void> {
  const packageRoot = await resolveOpenClawPackageRoot({
    cwd: process.cwd(),
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!packageRoot) {
    return;
  }

  const srcDir = path.join(packageRoot, "cli-scripts");
  if (!fs.existsSync(srcDir)) {
    return;
  }

  const destDir = path.join(resolveStateDir(), "scripts");
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir);
  for (const entry of entries) {
    const srcFile = path.join(srcDir, entry);
    const destFile = path.join(destDir, entry);
    const stat = fs.statSync(srcFile);
    if (!stat.isFile()) {
      continue;
    }
    fs.copyFileSync(srcFile, destFile);
    // Preserve executable permission
    fs.chmodSync(destFile, stat.mode);
  }
}
