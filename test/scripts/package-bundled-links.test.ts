import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasMissingBundledDependencies,
  materializeMissingBundledDependencies,
} from "../../scripts/lib/package-bundled-links.mts";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Match the real npm toolchain probe budget in the package E2E fixture.
const PACK_TIMEOUT_MS = 30_000;

async function fixture() {
  const root = tempDirs.make("openclaw-bundle-links-");
  const source = path.join(root, "checkout");
  const store = path.join(root, "store");
  const packed = path.join(root, "package");
  const modules = path.join(source, "node_modules");
  const bundle = path.join(modules, "fixture-bundle");
  const destination = path.join(packed, "node_modules", "fixture-bundle");
  await fs.mkdir(modules, { recursive: true });
  await fs.mkdir(store);
  await fs.mkdir(packed);
  const manifest = JSON.stringify({ name: "fixture-bundle", version: "1.0.0" });
  const payload = "#!/usr/bin/env node\nconsole.log('patched payload');\n";
  await fs.writeFile(path.join(store, "package.json"), manifest);
  await fs.writeFile(path.join(store, "cli.js"), payload, { mode: 0o755 });
  await fs.writeFile(
    path.join(packed, "package.json"),
    '{"bundleDependencies":["fixture-bundle"]}',
  );
  // The final packed manifest owns declarations, even after source restoration.
  await fs.writeFile(path.join(source, "package.json"), "{}");
  await fs.symlink(store, bundle, "junction");
  await fs.symlink(store, path.join(modules, "unbundled"), "junction");
  const original = await fs.lstat(bundle);
  const link = await fs.readlink(bundle);
  const originalCliMode = (await fs.stat(path.join(store, "cli.js"))).mode;
  const stage = (sourceDir = source) =>
    materializeMissingBundledDependencies(sourceDir, packed, PACK_TIMEOUT_MS);
  const writeManifest = (directory: string, value: unknown) =>
    fs.writeFile(path.join(directory, "package.json"), JSON.stringify(value));
  const rejectStage = async (error: string | RegExp) => {
    await expect(stage()).rejects.toThrow(error);
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await assertSourceUnchanged();
  };
  const assertSourceUnchanged = async () => {
    const current = await fs.lstat(bundle);
    expect(current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([original.dev, original.ino]);
    expect(await fs.readlink(bundle)).toBe(link);
    expect(await fs.readFile(path.join(store, "cli.js"), "utf8")).toBe(payload);
    expect((await fs.stat(path.join(store, "cli.js"))).mode).toBe(originalCliMode);
    expect(await fs.readlink(path.join(modules, "unbundled"))).toBe(link);
    expect((await fs.readdir(modules)).toSorted()).toEqual(["fixture-bundle", "unbundled"]);
  };
  return {
    source,
    store,
    packed,
    modules,
    bundle,
    destination,
    stage,
    writeManifest,
    rejectStage,
    assertSourceUnchanged,
  };
}

describe("bundled dependency links", () => {
  it.each(["shared", "patched", "reserved", "declared", "shadowed"])(
    "shares complete dependency closures without replacing %s sources",
    async (mode) => {
      const f = await fixture();
      const makePackage = async (
        name: string,
        dependencies: Record<string, string>,
        code: string,
      ) => {
        const root = path.join(f.source, "packages", name);
        await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
        await f.writeManifest(root, { name, version: "1.0.0", main: "index.js", dependencies });
        await fs.writeFile(path.join(root, "index.js"), code);
        return root;
      };
      const link = (owner: string, name: string, source: string) =>
        fs.symlink(source, path.join(owner, "node_modules", name), "junction");
      const helper = await makePackage(
        "helper",
        { leaf: "1.0.0" },
        'exports.value = "original"; exports.leaf = require("leaf");',
      );
      const leaf = await makePackage(
        "leaf",
        { helper: "1.0.0" },
        'module.exports = require.resolve("helper");',
      );
      await link(helper, "leaf", leaf);
      await link(leaf, "helper", helper);
      const patched = await makePackage(
        "patched",
        { leaf: "1.0.0" },
        'exports.value = "patched"; exports.leaf = require("leaf");',
      );
      await f.writeManifest(patched, {
        name: "helper",
        version: "1.0.0",
        main: "index.js",
        dependencies: { leaf: "1.0.0" },
      });
      await link(patched, "leaf", leaf);
      const second = await makePackage(
        "second",
        { helper: "1.0.0" },
        'module.exports = require("helper");',
      );
      const differentSource = mode === "patched" || mode === "shadowed";
      await link(second, "helper", differentSource ? patched : helper);
      await link(f.source, "second", second);
      await fs.mkdir(path.join(f.store, "node_modules"));
      await link(f.store, "helper", helper);
      await f.writeManifest(f.store, {
        name: "fixture-bundle",
        version: "1.0.0",
        main: "index.js",
        dependencies: { helper: "1.0.0" },
      });
      await fs.writeFile(path.join(f.store, "index.js"), 'module.exports = require("helper");');
      const bundles = ["fixture-bundle", "second"];
      const owners = new Map<string, string>();
      if (mode === "reserved") {
        // A later plugin-owned bundle must not replace a dependency hoisted by an earlier one.
        bundles.push("helper");
        const plugin = await makePackage("plugin", {}, "");
        await link(plugin, "helper", patched);
        owners.set("helper", plugin);
      }
      await f.writeManifest(f.packed, {
        bundleDependencies: bundles,
        ...(mode === "declared" ? { dependencies: { helper: "1.0.0" } } : {}),
        ...(mode === "shadowed" ? { optionalDependencies: { leaf: "1.0.0" } } : {}),
      });
      await materializeMissingBundledDependencies(f.source, f.packed, PACK_TIMEOUT_MS, owners);
      const load = (name: string) => createRequire(path.join(f.packed, "package.json"))(name);
      expect(load("fixture-bundle").value).toBe("original");
      expect(load("second").value).toBe(differentSource ? "patched" : "original");
      const rootHelper = path.join(f.packed, "node_modules/helper");
      if (mode === "reserved") {
        expect(load("helper").value).toBe("patched");
      } else if (mode === "declared") {
        await expect(fs.lstat(rootHelper)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(load("fixture-bundle").leaf).toBe(path.join(rootHelper, "index.js"));
        await expect(
          fs.lstat(path.join(f.destination, "node_modules/helper")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (mode === "shadowed") {
        // A nearer same-version patch must not satisfy the leaf needing original bytes.
        const original = path.join(
          f.packed,
          "node_modules/second/node_modules/helper/node_modules/leaf/node_modules/helper/index.js",
        );
        expect(load("second").leaf).toBe(original);
        expect(createRequire(path.join(f.packed, "package.json"))(original).value).toBe("original");
      }
      if (mode === "shared") {
        await expect(
          fs.lstat(path.join(f.packed, "node_modules/second/node_modules/helper")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each([true, false])(
    "respects publishable file selection with files allowlist=%s",
    async (allowlist) => {
      const f = await fixture();
      const manifest = JSON.stringify({
        name: "fixture-bundle",
        version: "1.0.0",
        main: "main.js",
        bin: { "fixture-bundle": "cli.js" },
        ...(allowlist ? { files: ["dist"] } : {}),
        scripts: { prepack: 'node -e "process.exit(91)"' },
      });
      await fs.mkdir(path.join(f.store, "dist"));
      const files = {
        "package.json": manifest,
        "main.js": "module.exports = 17;\n",
        "dist/kept.js": "exports.value = 'allowed';\n",
        "dist/ignored.js": "synthetic excluded nested payload\n",
        "dist/.npmignore": "ignored.js\n",
        LICENSE: "Synthetic test license\n",
        "README.md": "Synthetic test readme\n",
        "source-only.txt": "Synthetic excluded source\n",
        ".npmrc": "audit=false\n",
        ".env": "SYNTHETIC_FIXTURE_ONLY=not-a-secret\n",
        ".npmignore": ".env\nsource-only.txt\n",
      };
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(f.store, name), content);
      }
      await f.stage();
      expect(
        (
          await listDirectoryTreeStrict(f.destination).then((inventory) =>
            inventory.map((entry) => entry.relativePath),
          )
        ).toSorted(),
      ).toEqual(
        ["LICENSE", "README.md", "cli.js", "dist", "dist/kept.js", "main.js", "package.json"]
          .map((name) => name.split("/").join(path.sep))
          .toSorted(),
      );
      for (const name of [
        "package.json",
        "main.js",
        "dist/kept.js",
        "LICENSE",
        "README.md",
      ] as const) {
        expect(await fs.readFile(path.join(f.destination, name), "utf8")).toBe(files[name]);
      }
      for (const [name, content] of Object.entries(files)) {
        expect(await fs.readFile(path.join(f.store, name), "utf8")).toBe(content);
      }
      expect((await fs.lstat(f.destination)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(f.destination, "cli.js"))).toEqual(
        await fs.readFile(path.join(f.store, "cli.js")),
      );
      expect((await fs.stat(path.join(f.destination, "cli.js"))).mode).toBe(
        (await fs.stat(path.join(f.store, "cli.js"))).mode,
      );
      expect(await fs.readdir(path.dirname(f.destination))).toEqual(["fixture-bundle"]);
      await fs.writeFile(path.join(f.destination, "cli.js"), "staged modification");
      await f.assertSourceUnchanged();
    },
  );

  it("keeps the original source link when interrupted during copying", async ({ signal }) => {
    const f = await fixture();
    const helper = new URL("../../scripts/lib/package-bundled-links.mts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import fs from 'node:fs/promises';
import { once } from 'node:events';
// Pause after real payload copying, before inventory can start npm descendants.
const copy = fs.cp;
fs.cp = async (source, destination, options) => {
  await copy(source, destination, options);
  if (destination === process.argv[3]) {
    const resumed = once(process, 'message');
    process.send('copying');
    await resumed;
  }
};
const { materializeMissingBundledDependencies: stage } = await import(${JSON.stringify(helper)});
await stage(process.argv[1], process.argv[2], ${PACK_TIMEOUT_MS});
process.send('staged');`,
        f.source,
        f.packed,
        path.join(f.destination, "cli.js"),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = once(child, "close");
    try {
      const [message] = await Promise.race([
        once(child, "message", { signal }),
        closed.then(() => {
          throw new Error(stderr || "Packing child exited before copying");
        }),
      ]);
      expect(message).toBe("copying");
      expect(await fs.readFile(path.join(f.destination, "cli.js"), "utf8")).toContain(
        "patched payload",
      );
      await f.assertSourceUnchanged();
      expect(child.kill("SIGKILL")).toBe(true);
      await closed;
      await f.assertSourceUnchanged();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  });

  it("rejects an incomplete required dependency closure without touching the link", async () => {
    const f = await fixture();
    await f.writeManifest(f.store, {
      name: "fixture-bundle",
      version: "1.0.0",
      dependencies: { outside: "1.0.0" },
    });
    await f.rejectStage("dependency-closure staging");
  });

  it("rejects nested links without following them or mutating the source graph", async () => {
    const f = await fixture();
    await fs.symlink(f.modules, path.join(f.store, "external"), "junction");
    await f.rejectStage("nested symlink");
  });

  it("removes its copied destination when native package inventory fails", async () => {
    const f = await fixture();
    const invalidManifest = JSON.stringify({ name: "fixture-bundle" });
    await fs.writeFile(path.join(f.store, "package.json"), invalidManifest);
    await f.rejectStage("npm pack inventory failed");
    expect(await fs.readFile(path.join(f.store, "package.json"), "utf8")).toBe(invalidManifest);
  });

  it("keeps already packed materialized bundles without requiring their source", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination, { recursive: true });
    await fs.writeFile(path.join(f.destination, "owned"), "packed payload");
    const original = await fs.lstat(f.destination);
    await f.stage(path.join(f.source, "absent"));
    expect((await fs.lstat(f.destination)).ino).toBe(original.ino);
    expect(await fs.readFile(path.join(f.destination, "owned"), "utf8")).toBe("packed payload");
    await f.assertSourceUnchanged();
  });

  // pnpm layout: the root links into the store entry, whose node_modules holds the dependency.
  async function pnpmLinkedBundle({ storeLeftovers }: { storeLeftovers: boolean }) {
    const root = tempDirs.make("openclaw-bundle-pnpm-");
    const source = path.join(root, "checkout");
    const packed = path.join(root, "package");
    const entry = path.join(source, "node_modules/.pnpm/fixture-bundle@1.0.0/node_modules");
    const helper = path.join(source, "node_modules/.pnpm/fixture-helper@1.0.0/node_modules");
    const bundle = path.join(entry, "fixture-bundle");
    await fs.mkdir(bundle, { recursive: true });
    await fs.mkdir(path.join(helper, "fixture-helper"), { recursive: true });
    await fs.mkdir(packed);
    await fs.writeFile(path.join(source, "package.json"), "{}");
    await fs.writeFile(
      path.join(packed, "package.json"),
      JSON.stringify({ bundleDependencies: ["fixture-bundle"] }),
    );
    const manifest = {
      name: "fixture-bundle",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "fixture-helper": "1.0.0" },
    };
    await fs.writeFile(path.join(bundle, "package.json"), JSON.stringify(manifest));
    await fs.writeFile(
      path.join(bundle, "index.js"),
      'module.exports = require("fixture-helper");',
    );
    await fs.writeFile(
      path.join(helper, "fixture-helper/package.json"),
      JSON.stringify({ name: "fixture-helper", version: "1.0.0", main: "index.js" }),
    );
    await fs.writeFile(path.join(helper, "fixture-helper/index.js"), 'module.exports = "helper";');
    await fs.symlink(
      path.join(helper, "fixture-helper"),
      path.join(entry, "fixture-helper"),
      "junction",
    );
    await fs.symlink(bundle, path.join(source, "node_modules/fixture-bundle"), "junction");
    // What npm pack writes for the link: the bundle, plus its dependency at the store entry.
    const destination = path.join(packed, "node_modules/fixture-bundle");
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(path.join(bundle, "package.json"), path.join(destination, "package.json"));
    await fs.cp(path.join(bundle, "index.js"), path.join(destination, "index.js"));
    if (storeLeftovers) {
      const misplaced = path.join(
        packed,
        "node_modules/.pnpm/fixture-bundle@1.0.0/node_modules/fixture-helper",
      );
      await fs.mkdir(misplaced, { recursive: true });
      await fs.cp(path.join(helper, "fixture-helper"), misplaced, { recursive: true });
    }
    return { source, packed, destination };
  }

  it("restages a linked bundle whose dependencies npm left under its pnpm store entry", async () => {
    const f = await pnpmLinkedBundle({ storeLeftovers: true });
    await expect(
      materializeMissingBundledDependencies(f.source, f.packed, PACK_TIMEOUT_MS),
    ).resolves.toBe(true);
    expect(createRequire(path.join(f.destination, "package.json"))("./")).toBe("helper");
    await expect(fs.lstat(path.join(f.packed, "node_modules/.pnpm"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a packed linked bundle whose dependencies npm left nowhere", async () => {
    const f = await pnpmLinkedBundle({ storeLeftovers: false });
    const original = await fs.lstat(f.destination);
    await expect(
      materializeMissingBundledDependencies(f.source, f.packed, PACK_TIMEOUT_MS),
    ).resolves.toBe(false);
    expect((await fs.lstat(f.destination)).ino).toBe(original.ino);
    await expect(fs.lstat(path.join(f.destination, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["complete", ["node_modules/fixture-bundle/package.json"], false],
    ["missing", [], true],
    ["store-placed", ["node_modules/fixture-bundle/package.json", "node_modules/.pnpm/x/y"], true],
  ] as const)("flags a %s bundle layout for repair", async (_label, files, expected) => {
    const root = tempDirs.make("openclaw-bundle-tarball-");
    const tree = path.join(root, "package");
    for (const file of ["package.json", ...files]) {
      await fs.mkdir(path.dirname(path.join(tree, file)), { recursive: true });
      await fs.writeFile(path.join(tree, file), "{}");
    }
    await fs.writeFile(
      path.join(tree, "package.json"),
      JSON.stringify({ bundleDependencies: ["fixture-bundle"] }),
    );
    const tarball = path.join(root, "package.tgz");
    await createTar({ gzip: true, file: tarball, cwd: root }, ["package"]);
    await expect(hasMissingBundledDependencies(tarball)).resolves.toBe(expected);
  });

  it("rejects a missing archive bundle from a materialized source", async () => {
    const f = await fixture();
    await fs.unlink(f.bundle);
    await fs.mkdir(f.bundle);
    await fs.writeFile(path.join(f.bundle, "owned"), "source payload");
    const original = await fs.lstat(f.bundle);
    await expect(f.stage()).rejects.toThrow("missing from a materialized source");
    expect((await fs.lstat(f.bundle)).ino).toBe(original.ino);
    expect(await fs.readFile(path.join(f.bundle, "owned"), "utf8")).toBe("source payload");
  });

  it.each(["package", "node_modules", "bundle", "scope"])(
    "refuses a symlinked archive %s without writing through it",
    async (location) => {
      const f = await fixture();
      if (location === "package") {
        await fs.rm(f.packed, { recursive: true });
        await fs.symlink(f.source, f.packed, "junction");
      } else if (location === "node_modules") {
        await fs.symlink(f.modules, path.join(f.packed, "node_modules"), "junction");
      } else {
        await fs.mkdir(path.join(f.packed, "node_modules"));
        if (location === "scope") {
          await f.writeManifest(f.packed, { bundleDependencies: ["@scope/bundle"] });
          await fs.symlink(f.store, path.join(f.packed, "node_modules/@scope"), "junction");
        } else {
          await fs.symlink(f.store, f.destination, "junction");
        }
      }
      await expect(f.stage()).rejects.toThrow(/destination is (?:not a directory|occupied)/);
      await f.assertSourceUnchanged();
    },
  );

  it("refuses bundle names that escape the private archive", async () => {
    const f = await fixture();
    await f.writeManifest(f.packed, { bundleDependencies: ["../store"] });
    await expect(f.stage()).rejects.toThrow("Invalid bundled dependency name");
    await f.assertSourceUnchanged();
  });
});
