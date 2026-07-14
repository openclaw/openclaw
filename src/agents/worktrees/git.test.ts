import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitCheckoutRoot, hasSelfContainedGitMetadata, insideGitCheckout } from "./git.js";

describe("Git checkout discovery", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("returns the nearest checkout root for nested paths", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-root-"));
    const nested = path.join(root, "packages", "nested");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("returns null outside a checkout", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-git-root-"));

    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-metadata-"));
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });
});
