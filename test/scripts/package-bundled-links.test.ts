import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMissingBundledDependencies } from "../../scripts/lib/package-bundled-links.mts";
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
      expect((await fs.readdir(f.destination, { recursive: true })).toSorted()).toEqual(
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
