import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStableNodePath } from "./stable-node-path.js";

describe("resolveStableNodePath", () => {
  it("returns non-cellar paths unchanged", async () => {
    await expect(resolveStableNodePath("/usr/local/bin/node")).resolves.toBe("/usr/local/bin/node");
  });

  it("prefers the Homebrew opt symlink for default and versioned formulas", async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stable-node-"));
    const defaultNode = path.join(prefix, "Cellar", "node", "25.7.0", "bin", "node");
    const versionedNode = path.join(prefix, "Cellar", "node@22", "22.17.0", "bin", "node");
    const optDefault = path.join(prefix, "opt", "node", "bin", "node");
    const optVersioned = path.join(prefix, "opt", "node@22", "bin", "node");

    await fs.mkdir(path.dirname(optDefault), { recursive: true });
    await fs.mkdir(path.dirname(optVersioned), { recursive: true });
    await fs.writeFile(optDefault, "", "utf8");
    await fs.writeFile(optVersioned, "", "utf8");

    await expect(resolveStableNodePath(defaultNode)).resolves.toBe(optDefault);
    await expect(resolveStableNodePath(versionedNode)).resolves.toBe(optVersioned);
  });

  it("resolves Volta tools/image path to the stable Volta shim", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stable-node-volta-"));
    const voltaImageNode = path.join(
      home,
      ".volta",
      "tools",
      "image",
      "node",
      "24.14.0",
      "bin",
      "node",
    );
    const voltaShim = path.join(home, ".volta", "bin", "node");

    await fs.mkdir(path.dirname(voltaShim), { recursive: true });
    await fs.writeFile(voltaShim, "", "utf8");

    await expect(resolveStableNodePath(voltaImageNode)).resolves.toBe(voltaShim);
  });

  it("returns Volta tools/image path unchanged when shim is not accessible", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stable-node-volta-"));
    const voltaImageNode = path.join(
      home,
      ".volta",
      "tools",
      "image",
      "node",
      "24.14.0",
      "bin",
      "node",
    );
    // No shim created — shim directory doesn't exist.
    await expect(resolveStableNodePath(voltaImageNode)).resolves.toBe(voltaImageNode);
  });

  it("falls back to the bin symlink for the default formula, otherwise original path", async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stable-node-"));
    const defaultNode = path.join(prefix, "Cellar", "node", "25.7.0", "bin", "node");
    const versionedNode = path.join(prefix, "Cellar", "node@22", "22.17.0", "bin", "node");
    const binNode = path.join(prefix, "bin", "node");

    await fs.mkdir(path.dirname(binNode), { recursive: true });
    await fs.writeFile(binNode, "", "utf8");

    await expect(resolveStableNodePath(defaultNode)).resolves.toBe(binNode);
    await expect(resolveStableNodePath(versionedNode)).resolves.toBe(versionedNode);
  });
});
