import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { detectPackageManager } from "./detect-package-manager.js";

async function withPackageManagerRoot<T>(
  files: Array<{ path: string; content: string }>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  return await withTempDir({ prefix: "openclaw-detect-pm-" }, async (root) => {
    for (const file of files) {
      await fs.writeFile(path.join(root, file.path), file.content, "utf8");
    }
    return await run(root);
  });
}

describe("detectPackageManager", () => {
  it("prefers packageManager from package.json when supported", async () => {
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@10.8.1" }) },
        { path: "package-lock.json", content: "" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("pnpm");
      },
    );
  });

  it.each([
    {
      name: "uses bun.lock",
      files: [{ path: "bun.lock", content: "" }],
      expected: "bun",
    },
    {
      name: "uses bun.lockb",
      files: [{ path: "bun.lockb", content: "" }],
      expected: "bun",
    },
    {
      name: "falls back to npm lockfiles for unsupported packageManager values",
      files: [
        { path: "package.json", content: JSON.stringify({ packageManager: "yarn@4.0.0" }) },
        { path: "package-lock.json", content: "" },
      ],
      expected: "npm",
    },
  ])("falls back to lockfiles when $name", async ({ files, expected }) => {
    await withPackageManagerRoot(files, async (root) => {
      await expect(detectPackageManager(root)).resolves.toBe(expected);
    });
  });

  it("returns null when no package manager markers exist", async () => {
    await withPackageManagerRoot(
      [{ path: "package.json", content: "{not-json}" }],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBeNull();
      },
    );
  });
});
