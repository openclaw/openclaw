import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readPluginControlUiAssets } from "../plugins/control-ui-assets.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { readPluginCacheFile } from "../plugins/plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(setup?: (source: string) => Promise<void>) {
  const root = await fs.realpath(dirs.make("retained-runtime-link-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "retained");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "package");
  await fs.mkdir(path.join(source, "dist", "state"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
  await fs.mkdir(candidateRoot);
  const worker = path.join(source, "dist", "state", "worker.js");
  await fs.writeFile(worker, "export const generation = 'retained';\n");
  await fs.chmod(worker, 0o444);
  // pnpm stores publish package files as hard links of one inode.
  await fs.link(worker, path.join(source, "dist", "worker-alias.js"));
  const launcher = path.join(source, "node_modules", ".bin", "tool");
  await fs.writeFile(launcher, `#!/bin/sh\nexec "$basedir/../tool/cli.js"\n`);
  await fs.symlink(
    path.join("..", "dist", "state", "worker.js"),
    path.join(source, "node_modules", "link.js"),
  );
  await setup?.(source);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return {
    source,
    worker,
    launcher,
    destination,
    plan,
    link: (assertCurrent = () => {}) =>
      linkUpdateCandidatePluginTrees(plan, {
        targetStateDir,
        candidateRoot,
        assertCurrent,
        onProgress: assertCurrent,
      }),
  };
}

it.each([
  { filesystem: "native", existingTwin: false },
  { filesystem: "native", existingTwin: true },
  { filesystem: "overlay", existingTwin: false },
  { filesystem: "overlay", existingTwin: true },
])(
  "preserves plugin safety on $filesystem filesystems (existing manifest twin=$existingTwin)",
  async ({ filesystem, existingTwin }) => {
    const controlUi = { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] };
    const nestedBrowser = "dist/control-ui/@scope/nested";
    const files = new Map([
      [
        "openclaw.plugin.json",
        JSON.stringify({
          id: "fixture",
          configSchema: { type: "object" },
          providerCatalogEntry: "src/catalog.ts",
          capabilityCatalogEntry: "src/capabilities.ts",
          controlUi,
          themes: [
            {
              id: "fixture",
              name: "Fixture",
              description: "Fixture palette",
              source: "theme.json",
              hats: { beret: "assets/beret.svg" },
              critters: { ferris: { source: "assets/ferris.svg" } },
            },
          ],
        }),
      ],
      [
        "package.json",
        JSON.stringify({
          name: "fixture",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup.ts",
            runtimeSetupEntry: "./dist/setup.js",
          },
        }),
      ],
      ["index.ts", "export default { id: 'fixture', register() {} };\n"],
      ["dist/index.js", "export default { id: 'fixture', register() {} };\n"],
      ["setup.ts", "export const setup = {};\n"],
      ["dist/setup.js", "export const setup = {};\n"],
      ["src/catalog.ts", "export const providers = [];\n"],
      ["src/catalog.js", "export const providers = [];\n"],
      ["src/capabilities.ts", "export const capabilities = {};\n"],
      ["provider-policy-api.ts", "export const policy = {};\n"],
      ["assets/icon.png", "fixture icon"],
      ["assets/activity.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["assets/activity/tool.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["theme.json", "{}"],
      ["assets/beret.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["assets/ferris.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["dist/control-ui/index.js", "export {};\n"],
      ["dist/control-ui/chunks/shared.js", "export {};\n"],
      ["dist/control-ui/theme.css", ":root {}\n"],
      [
        "dist/control-ui/icons/openclaw.plugin.json",
        JSON.stringify({ id: "icons", configSchema: { type: "object" } }),
      ],
      ["dist/control-ui/icons/assets/activity/shared.js", "export {};\n"],
      [
        `${nestedBrowser}/openclaw.plugin.json`,
        JSON.stringify({
          id: "nested",
          configSchema: { type: "object" },
          controlUi: { entry: "dist/control-ui/index.js" },
        }),
      ],
      [`${nestedBrowser}/dist/control-ui/index.js`, "export {};\n"],
    ]);
    const payloads = [
      "assets/large-model.bin",
      "lib/implementation.js",
      "data/payload.json",
      "dist/control-ui/README.txt",
    ];
    const relativePlugin = path.join("extensions", "fixture");
    const f = await fixture(async (source) => {
      for (const [relativePath, content] of files) {
        const file = path.join(source, relativePlugin, relativePath);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
      }
      for (const relative of payloads) {
        const file = path.join(source, relativePlugin, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          relative.endsWith(".bin") ? Buffer.alloc(2 * 1024 * 1024) : "{}\n",
        );
      }
      if (existingTwin) {
        await fs.link(
          path.join(source, relativePlugin, "openclaw.plugin.json"),
          path.join(path.dirname(source), "existing-manifest.json"),
        );
      }
    });
    // Exercise both cross-kind and same-kind scopes in the unfavorable input order.
    const nestedManifest = path.join("icons", "openclaw.plugin.json");
    const outerManifest = path.join(f.source, relativePlugin, "openclaw.plugin.json");
    const rank = (file: string) =>
      file.endsWith(nestedManifest) ? 0 : file === outerManifest ? 1 : 2;
    f.plan.entries.sort((left, right) => rank(left.path) - rank(right.path));
    const overlay = filesystem === "overlay";
    const disk = await fs.statfs(f.source);
    // Pin both routes so an OverlayFS host cannot hide broken plugin-specific copying.
    disk.type = overlay ? 0x794c7630 : 0xef53;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfs").mockResolvedValue(disk);
    const link = vi.spyOn(fs, "link");
    const counts = await f.link();
    for (const base of [f.source, f.destination]) {
      const rootDir = path.join(base, relativePlugin);
      withPluginCache(createPluginCache(), () => {
        expect(loadPluginManifest(rootDir)).toMatchObject(
          base === f.source && existingTwin
            ? { ok: false, error: expect.stringContaining("unsafe plugin manifest path") }
            : { ok: true, manifest: { id: "fixture" } },
        );
        for (const [relativePath, content] of files) {
          const preexistingHardlink =
            base === f.source && existingTwin && relativePath === "openclaw.plugin.json";
          expect(fsSync.statSync(path.join(rootDir, relativePath)).nlink).toBe(
            preexistingHardlink ? 2 : 1,
          );
          const file = readPluginCacheFile({ rootDir, relativePath, rejectHardlinks: true });
          expect(file.ok).toBe(!preexistingHardlink);
          expect(fsSync.readFileSync(path.join(rootDir, relativePath), "utf8")).toBe(content);
        }
      });
      expect([...(await readPluginControlUiAssets(rootDir, controlUi)).assets.keys()]).toEqual(
        expect.arrayContaining([
          "index.js",
          "chunks/shared.js",
          "theme.css",
          "icons/assets/activity/shared.js",
        ]),
      );
      expect([
        ...(
          await readPluginControlUiAssets(path.join(rootDir, nestedBrowser), {
            entry: "dist/control-ui/index.js",
          })
        ).assets.keys(),
      ]).toEqual(["index.js"]);
    }
    expect(counts).toEqual(
      overlay
        ? { linked: 0, copied: files.size + payloads.length + 3 }
        : { linked: payloads.length + 2, copied: files.size + 1 },
    );
    expect(link).toHaveBeenCalledTimes(counts.linked);
    for (const relative of payloads) {
      const original = fsSync.statSync(path.join(f.source, relativePlugin, relative));
      const retained = fsSync.statSync(path.join(f.destination, relativePlugin, relative));
      expect(retained.ino === original.ino).toBe(!overlay);
      expect(original.nlink).toBe(overlay ? 1 : 2);
      expect(retained.nlink).toBe(overlay ? 1 : 2);
      expect(retained.size).toBe(original.size);
    }
    const sourcePlugin = path.join(f.source, relativePlugin);
    await fs.link(
      path.join(sourcePlugin, "openclaw.plugin.json"),
      path.join(f.source, "foreign-manifest.json"),
    );
    expect(fsSync.statSync(path.join(sourcePlugin, "openclaw.plugin.json")).nlink).toBe(
      existingTwin ? 3 : 2,
    );
    expect(
      withPluginCache(createPluginCache(), () => loadPluginManifest(sourcePlugin)),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsafe plugin manifest path"),
    });
  },
);

it("retains files by hard link so the inodes outlive package replacement", async () => {
  const f = await fixture();
  const before = await fs.stat(f.worker, { bigint: true });
  const counts = await f.link();
  const retainedWorker = path.join(f.destination, "dist", "state", "worker.js");
  expect(counts).toEqual({ linked: 2, copied: 1 });
  expect((await fs.stat(retainedWorker, { bigint: true })).ino).toBe(before.ino);
  expect(
    (await fs.stat(path.join(f.destination, "dist", "worker-alias.js"), { bigint: true })).ino,
  ).toBe(before.ino);
  // The launcher is rewritten for its new location; the live package must not change.
  const retainedLauncher = path.join(f.destination, "node_modules", ".bin", "tool");
  expect((await fs.stat(retainedLauncher, { bigint: true })).ino).not.toBe(
    (await fs.stat(f.launcher, { bigint: true })).ino,
  );
  expect(await fs.readFile(f.launcher, "utf8")).toContain('"$basedir/../tool/cli.js"');
  expect(await fs.readlink(path.join(f.destination, "node_modules", "link.js"))).toBe(
    path.join("..", "dist", "state", "worker.js"),
  );
  const displaced = `${f.source}.previous`;
  await fs.rename(f.source, displaced);
  await fs.rm(displaced, { recursive: true });
  expect(await fs.readFile(retainedWorker, "utf8")).toBe("export const generation = 'retained';\n");
  expect((await fs.stat(retainedWorker)).mode & 0o777).toBe(0o444);
});

it("copies overlay files without copy-up changing their admitted identity", async () => {
  const nestedFiles = Array.from({ length: 8 }, (_, index) =>
    path.join("node_modules", "fixture", "dist", "deep", "chunks", `part-${index}.js`),
  );
  const f = await fixture(async (source) => {
    for (const file of nestedFiles) {
      const destination = path.join(source, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `// ${file}\n`, { mode: 0o444 });
    }
    await fs.chmod(path.dirname(path.join(source, nestedFiles[0]!)), 0o751);
  });
  // Discovery can encounter a file before its parent directory's inventory entry.
  f.plan.entries.sort(
    (left, right) => Number(left.kind === "directory") - Number(right.kind === "directory"),
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const disk = await fs.statfs(f.source);
  disk.type = 0x794c7630;
  vi.spyOn(fs, "statfs").mockResolvedValue(disk);
  const link = vi.spyOn(fs, "link");
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, f.link)).toEqual({
    linked: 0,
    copied: 3 + nestedFiles.length,
  });
  expect(link).not.toHaveBeenCalled();
  // Nested leaves must not repeat an ancestor-creation walk for every copied file.
  expect(mkdir.mock.calls.length).toBeLessThanOrEqual(
    f.plan.entries.filter((entry) => entry.kind === "directory").length + 1,
  );
  const retainedWorker = path.join(f.destination, "dist", "state", "worker.js");
  expect((await fs.stat(retainedWorker)).ino).not.toBe((await fs.stat(f.worker)).ino);
  expect(await fs.readFile(retainedWorker, "utf8")).toBe("export const generation = 'retained';\n");
  expect((await fs.stat(retainedWorker)).mode & 0o777).toBe(0o444);
  for (const file of nestedFiles) {
    const retained = path.join(f.destination, file);
    expect(await fs.readFile(retained, "utf8")).toBe(`// ${file}\n`);
    expect((await fs.stat(retained)).mode & 0o777).toBe(0o444);
  }
  expect(
    (await fs.stat(path.dirname(path.join(f.destination, nestedFiles[0]!)))).mode & 0o777,
  ).toBe(0o751);
});

it.each([0, 1])("copies shared inode occurrence %i when hard links are refused", async (index) => {
  const f = await fixture();
  const before = await fs.stat(f.worker, { bigint: true });
  const sharedEntries = f.plan.entries.filter(
    (entry) => entry.kind === "file" && entry.ino === before.ino.toString(),
  );
  f.plan.entries = [
    ...sharedEntries,
    ...f.plan.entries.filter((entry) => !sharedEntries.includes(entry)),
  ];
  // Exercise copy-before-link and link-before-copy without relying on directory order.
  const fallback = sharedEntries[index]!.path;
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
    if (String(existing) === fallback) {
      throw Object.assign(new Error("hard link unavailable"), {
        code: index === 0 ? "EXDEV" : "EMLINK",
      });
    }
    return await link(existing, target);
  });
  expect(await f.link()).toEqual({ linked: 1, copied: 2 });
  const retainedWorker = path.join(f.destination, path.relative(f.source, fallback));
  const copied = await fs.stat(retainedWorker, { bigint: true });
  expect(copied.ino).not.toBe(before.ino);
  expect(Number(copied.mode & 0o777n)).toBe(0o444);
  expect(await fs.readFile(retainedWorker, "utf8")).toBe("export const generation = 'retained';\n");
});

it("refuses entries that changed after the inventory and never links a replacement", async () => {
  const f = await fixture();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
    if (String(existing) === f.worker) {
      throw new Error("must not link a changed file");
    }
    return await link(existing, target);
  });
  fsSync.renameSync(f.worker, `${f.worker}.original`);
  fsSync.writeFileSync(f.worker, "export const generation = 'replaced';\n", { mode: 0o444 });
  await expect(f.link()).rejects.toThrow("changed after snapshot inventory");
  expect(fsSync.existsSync(path.join(f.destination, "dist", "state", "worker.js"))).toBe(false);
});

it.each(["next-entry", "copy-publication"] as const)(
  "refuses unexpected ctime changes after a prior hard link (%s)",
  async (stage) => {
    const f = await fixture();
    const before = await fs.stat(f.worker, { bigint: true });
    const sharedEntries = f.plan.entries.filter(
      (entry) => entry.kind === "file" && entry.ino === before.ino.toString(),
    );
    const later = sharedEntries[1]!.path;
    if (stage === "next-entry") {
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (args[0] === later && "ctimeNs" in stat && typeof stat.ctimeNs === "bigint") {
          stat.ctimeNs += 1n;
        }
        return stat;
      });
    } else {
      const link = fs.link;
      vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
        if (existing === later) {
          throw Object.assign(new Error("hard link unavailable"), { code: "EMLINK" });
        }
        return await link(existing, target);
      });
      const lstatSync = fsSync.lstatSync;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstatSync(...args);
        if (args[0] === later && stat && "ctimeNs" in stat && typeof stat.ctimeNs === "bigint") {
          stat.ctimeNs += 1n;
        }
        return stat;
      });
    }
    await expect(f.link()).rejects.toThrow("changed after snapshot inventory");
    expect(fsSync.existsSync(path.join(f.destination, path.relative(f.source, later)))).toBe(false);
  },
);

async function fileWindowFixture() {
  const f = await fixture(async (source) => {
    await fs.mkdir(path.join(source, "parallel"));
    for (let index = 0; index < 9; index += 1) {
      await fs.writeFile(
        path.join(source, "parallel", `${index}.js`),
        `export default ${index};\n`,
      );
    }
  });
  const parent = path.join(f.source, "parallel");
  const files = f.plan.entries.filter((entry) => path.dirname(entry.path) === parent);
  f.plan.entries = [...files, ...f.plan.entries.filter((entry) => !files.includes(entry))];
  // Complete admission reads in one microtask turn so native writes expose their
  // overlap independently of filesystem read latency and callback ordering.
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === parent) {
      return fsSync.lstatSync(args[0], { bigint: true });
    }
    return await lstat(...args);
  });
  const disk = await fs.statfs(f.source);
  disk.type = 0xef53;
  vi.spyOn(fs, "statfs").mockResolvedValue(disk);
  return { ...f, files };
}

it("overlaps independent file writes with a bounded window and one parent creation", async () => {
  const f = await fileWindowFixture();
  const link = fs.link;
  let active = 0;
  let maximum = 0;
  vi.spyOn(fs, "link").mockImplementation(async (...args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      return await link(...args);
    } finally {
      active -= 1;
    }
  });
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await f.link()).toEqual({ linked: 11, copied: 1 });
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(
    mkdir.mock.calls.filter(([directory]) => directory === path.join(f.destination, "parallel")),
  ).toHaveLength(1);
  for (const entry of f.files) {
    const retained = path.join(f.destination, path.relative(f.source, entry.path));
    expect((await fs.stat(retained)).ino.toString()).toBe(entry.ino);
  }
});

it("settles admitted writes before rejecting a failed window and leaves later entries untouched", async () => {
  const f = await fileWindowFixture();
  const failure = new Error("retained link failed");
  const link = fs.link;
  let active = 0;
  const attempted: string[] = [];
  vi.spyOn(fs, "link").mockImplementation(async (existing, destination) => {
    attempted.push(String(existing));
    if (existing === f.files[1]!.path) {
      throw failure;
    }
    active += 1;
    try {
      await link(existing, destination);
    } finally {
      active -= 1;
    }
  });
  await expect(
    f.link().catch((error: unknown) => {
      expect(active).toBe(0);
      throw error;
    }),
  ).rejects.toBe(failure);
  expect(attempted).not.toContain(f.files[4]!.path);
  expect(fsSync.existsSync(path.join(f.destination, "node_modules"))).toBe(false);
});

it.each(["parent", "relocation", "alias"] as const)(
  "rechecks authority after awaited %s preparation before writing",
  async (stage) => {
    const f = await fixture(async (source) => {
      await fs.writeFile(
        path.join(source, "node_modules", ".bin", "tool"),
        `#!/bin/sh\nexec "${source}/dist/state/worker.js"\n`,
      );
    });
    const revoked = new Error("update authority revoked");
    let current = true;
    const retainedLauncher = path.join(f.destination, "node_modules", ".bin", "tool");
    const alias = path.join(f.plan.privateRoot, "module-alias");
    if (stage === "parent") {
      f.plan.entries.sort(
        (left, right) => Number(right.path === f.worker) - Number(left.path === f.worker),
      );
      const mkdir = fs.mkdir;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === path.join(f.destination, "dist", "state")) {
          current = false;
        }
        return result;
      });
    } else if (stage === "relocation") {
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const contents = await readFile(...args);
        if (args[0] === retainedLauncher) {
          current = false;
        }
        return contents;
      });
    } else {
      f.plan.aliases.push([alias, f.destination]);
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        try {
          return await lstat(...args);
        } finally {
          if (args[0] === alias) {
            current = false;
          }
        }
      });
    }
    await expect(
      f.link(() => {
        if (!current) {
          throw revoked;
        }
      }),
    ).rejects.toBe(revoked);
    if (stage === "relocation") {
      expect(await fs.readFile(retainedLauncher, "utf8")).toBe(
        await fs.readFile(f.launcher, "utf8"),
      );
    } else {
      expect(
        fsSync.existsSync(
          stage === "alias" ? alias : path.join(f.destination, "dist", "state", "worker.js"),
        ),
      ).toBe(false);
    }
  },
);
