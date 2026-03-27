import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "./detect-package-manager.js";

async function createPackageManagerRoot(
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
  for (const file of files) {
    await fs.writeFile(path.join(root, file.path), file.content, "utf8");
  }
  return root;
}

describe("detectPackageManager", () => {
  it("prefers packageManager from package.json when supported", async () => {
    const root = await createPackageManagerRoot([
      { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@10.8.1" }) },
      { path: "package-lock.json", content: "" },
    ]);

    await expect(detectPackageManager(root)).resolves.toBe("pnpm");
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
    await expect(detectPackageManager(await createPackageManagerRoot(files))).resolves.toBe(
      expected,
    );
  });

  it("returns null when no package manager markers exist", async () => {
    const root = await createPackageManagerRoot([{ path: "package.json", content: "{not-json}" }]);

    await expect(detectPackageManager(root)).resolves.toBeNull();
  });
});
