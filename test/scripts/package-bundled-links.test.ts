import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMaterializedBundledDependencies } from "../../scripts/lib/package-bundled-links.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = tempDirs.make("openclaw-bundle-links-");
  const source = path.join(root, "checkout");
  const store = path.join(root, "store");
  const modules = path.join(source, "node_modules");
  const bundle = path.join(modules, "fixture-bundle");
  await fs.mkdir(modules, { recursive: true });
  await fs.mkdir(store);
  await fs.writeFile(
    path.join(store, "package.json"),
    JSON.stringify({ name: "fixture-bundle", version: "1.0.0" }),
  );
  await fs.writeFile(
    path.join(store, "cli.js"),
    "#!/usr/bin/env node\nconsole.log('patched payload');\n",
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ bundleDependencies: ["fixture-bundle"] }),
  );
  await fs.symlink(store, bundle, "junction");
  await fs.symlink(store, path.join(modules, "unbundled"), "junction");
  const original = await fs.lstat(bundle);
  const link = await fs.readlink(bundle);
  const assertRestored = async () => {
    const current = await fs.lstat(bundle);
    expect(current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([original.dev, original.ino]);
    expect(await fs.readlink(bundle)).toBe(link);
    expect((await fs.readdir(modules)).toSorted()).toEqual(["fixture-bundle", "unbundled"]);
  };
  return { source, store, modules, bundle, assertRestored };
}

describe("bundled dependency links", () => {
  it("materializes only the declared payload with modes and restores the original link", async () => {
    const f = await fixture();
    const originalBytes = await fs.readFile(path.join(f.store, "cli.js"));
    const originalMode = (await fs.stat(path.join(f.store, "cli.js"))).mode;
    const result = await withMaterializedBundledDependencies(f.source, async () => {
      expect((await fs.lstat(f.bundle)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(f.bundle, "cli.js"))).toEqual(originalBytes);
      expect((await fs.stat(path.join(f.bundle, "cli.js"))).mode).toBe(originalMode);
      expect((await fs.lstat(path.join(f.modules, "unbundled"))).isSymbolicLink()).toBe(true);
      await fs.writeFile(path.join(f.bundle, "cli.js"), "staged modification");
      expect(await fs.readFile(path.join(f.store, "cli.js"))).toEqual(originalBytes);
      return "packed";
    });
    expect(result).toBe("packed");
    await f.assertRestored();
  });

  it("restores the link when packing fails and preserves the original error", async () => {
    const f = await fixture();
    const failure = new Error("pack failed");
    await expect(
      withMaterializedBundledDependencies(f.source, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await f.assertRestored();
  });

  it.each(["dependencies", "optionalDependencies"])(
    "rejects an incomplete %s closure without touching the link",
    async (field) => {
      const f = await fixture();
      await fs.writeFile(
        path.join(f.store, "package.json"),
        JSON.stringify({ name: "fixture-bundle", [field]: { outside: "1.0.0" } }),
      );
      let packed = false;
      await expect(
        withMaterializedBundledDependencies(f.source, async () => {
          packed = true;
        }),
      ).rejects.toThrow("dependency-closure staging");
      expect(packed).toBe(false);
      await f.assertRestored();
    },
  );

  it("rejects nested links, cleans partial staging, and restores earlier bundles", async () => {
    const f = await fixture();
    const second = path.join(f.source, "second");
    await fs.mkdir(second);
    await fs.writeFile(path.join(second, "package.json"), '{"name":"second"}');
    await fs.symlink(f.store, path.join(second, "external"), "junction");
    const secondLink = path.join(f.modules, "second");
    await fs.symlink(second, secondLink, "junction");
    await fs.writeFile(
      path.join(f.source, "package.json"),
      '{"bundleDependencies":["fixture-bundle","second"]}',
    );
    await expect(
      withMaterializedBundledDependencies(f.source, async () => "not reached"),
    ).rejects.toThrow("nested symlink");
    expect(await fs.readlink(secondLink)).toBe(second);
    await fs.unlink(secondLink);
    await f.assertRestored();
  });

  it("leaves existing materialized bundles untouched", async () => {
    const f = await fixture();
    await fs.unlink(f.bundle);
    await fs.mkdir(f.bundle);
    const original = await fs.stat(f.bundle);
    await withMaterializedBundledDependencies(f.source, async () => {
      expect((await fs.stat(f.bundle)).ino).toBe(original.ino);
      await fs.writeFile(path.join(f.bundle, "owned"), "unchanged owner");
    });
    expect(await fs.readFile(path.join(f.bundle, "owned"), "utf8")).toBe("unchanged owner");
    expect((await fs.stat(f.bundle)).ino).toBe(original.ino);
  });

  it("preserves another occupant and original-link recovery after ownership changes", async () => {
    const f = await fixture();
    await expect(
      withMaterializedBundledDependencies(f.source, async () => {
        await fs.rename(f.bundle, `${f.bundle}-moved`);
        await fs.mkdir(f.bundle);
        await fs.writeFile(path.join(f.bundle, "foreign"), "keep");
        throw new Error("pack failed after replacement");
      }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "pack failed after replacement" }),
        expect.objectContaining({ message: expect.stringContaining("path changed") }),
      ],
    });
    expect(await fs.readFile(path.join(f.bundle, "foreign"), "utf8")).toBe("keep");
    const recovery = (await fs.readdir(f.modules)).filter((name) =>
      name.startsWith(".openclaw-bundle-"),
    );
    expect(recovery).toHaveLength(1);
    expect(await fs.readlink(path.join(f.modules, recovery[0]!, "original"))).toBe(f.store);
  });

  it("refuses bundle names that escape node_modules before invoking the packer", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "package.json"), '{"bundleDependencies":["../store"]}');
    let packed = false;
    await expect(
      withMaterializedBundledDependencies(f.source, async () => {
        packed = true;
      }),
    ).rejects.toThrow("Invalid bundled dependency name");
    expect(packed).toBe(false);
    await f.assertRestored();
  });
});
