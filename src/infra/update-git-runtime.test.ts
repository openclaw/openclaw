import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuiltRuntimeCommit } from "./update-git-runtime.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  // Resolve the temp root: macOS reports /var while prod resolvers return /private/var.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-built-commit-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

describe("readBuiltRuntimeCommit", () => {
  it("reads the commit the dist was built from", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.8.1", commit: "1623683f478b1e4a2e3d5632585f006ea142e08c" }),
    );

    expect(await readBuiltRuntimeCommit(root)).toBe("1623683f478b1e4a2e3d5632585f006ea142e08c");
  });

  it("returns null when the checkout has no build", async () => {
    // Source-only checkouts must not be reported as running a stale build.
    expect(await readBuiltRuntimeCommit(await createRoot())).toBeNull();
  });

  it("returns null when build provenance omits the commit", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.8.1" }),
    );

    expect(await readBuiltRuntimeCommit(root)).toBeNull();
  });
});
