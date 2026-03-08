import fs from "node:fs";
import path from "node:path";
import { SharpUnavailableError } from "../media/image-ops.js";
import { note } from "../terminal/note.js";

export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");
  const srcEntry = path.join(root, "src", "entry.ts");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install");
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

/**
 * Warns when the sharp native image-processing module cannot be loaded.
 * This typically happens on Linux hosts with CPUs that lack SSE4.2 (x86-64-v2),
 * causing all image optimization to fail even for images that are already small.
 */
export async function noteSharpAvailability(): Promise<void> {
  // sips handles image ops on macOS without sharp.
  if (process.platform === "darwin") {
    return;
  }

  try {
    await import("sharp");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Use SharpUnavailableError just for its formatted message; don't throw.
    const friendly = new SharpUnavailableError(err);
    note(
      [
        `- ${friendly.message}`,
        `  Detail: ${detail}`,
        "",
        "  To fix:",
        "    • Ensure your CPU supports SSE4.2 (x86-64-v2 baseline)",
        "    • Rebuild: npm rebuild sharp",
        "    • Or install system vips: apt-get install libvips-dev",
        "",
        "  Images already within size/dimension limits will still pass through.",
        "  Resize/re-encode operations will fail with an actionable error.",
      ].join("\n"),
      "Image backend",
    );
  }
}
