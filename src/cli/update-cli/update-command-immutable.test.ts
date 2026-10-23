import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryRunImmutableUpdateCommand } from "./update-command-immutable.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-immutable-compat-"));
  roots.push(root);
  return root;
}

describe("immutable update compatibility guard", () => {
  it("allows ordinary mutable installations", async () => {
    const root = await tempRoot();
    await expect(tryRunImmutableUpdateCommand({ sourceUpdate: { root } })).resolves.toBe(false);
  });

  it("refuses a sealed generation before mutable update admission", async () => {
    const root = await tempRoot();
    const generation = path.join(root, "releases", "a".repeat(40));
    await expect(
      tryRunImmutableUpdateCommand({ sourceUpdate: { root: generation } }),
    ).rejects.toThrow("Immutable installations cannot be updated");
  });

  it("refuses an immutable current/releases layout", async () => {
    const root = await tempRoot();
    const generation = path.join(root, "releases", "b".repeat(40));
    await fs.mkdir(generation, { recursive: true });
    await fs.symlink(generation, path.join(root, "current"));
    await expect(tryRunImmutableUpdateCommand({ sourceUpdate: { root } })).rejects.toThrow(
      "Immutable installations cannot be updated",
    );
  });
});
