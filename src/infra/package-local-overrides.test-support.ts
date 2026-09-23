import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
export function useLocalOverrideTestState() {
  let originalStateDir: string | undefined;
  let packageUpdateTestStateDir = "";

  beforeAll(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    packageUpdateTestStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-package-update-state-"),
    );
    process.env.OPENCLAW_STATE_DIR = packageUpdateTestStateDir;
  });

  afterAll(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(packageUpdateTestStateDir, { recursive: true, force: true });
  });
}
export async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

export async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}
