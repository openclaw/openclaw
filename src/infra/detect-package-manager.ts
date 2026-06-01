import fs from "node:fs/promises";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

type DetectPackageManagerOptions = {
  preferPackageLockfiles?: boolean;
};

function detectPackageManagerFromLockfiles(files: string[]): DetectedPackageManager | null {
  if (files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (files.includes("bun.lock") || files.includes("bun.lockb")) {
    return "bun";
  }
  if (files.includes("npm-shrinkwrap.json") || files.includes("package-lock.json")) {
    return "npm";
  }
  return null;
}

export async function detectPackageManager(
  root: string,
  options?: DetectPackageManagerOptions,
): Promise<DetectedPackageManager | null> {
  const files = await fs.readdir(root).catch((): string[] => []);
  if (options?.preferPackageLockfiles) {
    const detected = detectPackageManagerFromLockfiles(files);
    if (detected) {
      return detected;
    }
  }

  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  return detectPackageManagerFromLockfiles(files);
}
