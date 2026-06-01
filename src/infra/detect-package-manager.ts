import fs from "node:fs/promises";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  const files = await fs.readdir(root).catch((): string[] => []);
  const hasNpmShrinkwrap = files.includes("npm-shrinkwrap.json");
  const hasPnpmLock = files.includes("pnpm-lock.yaml");
  const hasPnpmWorkspace = files.includes("pnpm-workspace.yaml");
  if (hasNpmShrinkwrap && !hasPnpmLock && !hasPnpmWorkspace) {
    return "npm";
  }

  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  if (hasPnpmLock) {
    return "pnpm";
  }
  if (files.includes("bun.lock") || files.includes("bun.lockb")) {
    return "bun";
  }
  if (files.includes("package-lock.json") || hasNpmShrinkwrap) {
    return "npm";
  }
  return null;
}
