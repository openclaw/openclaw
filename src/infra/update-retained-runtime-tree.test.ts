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
import * as fileDescriptor from "./file-descriptor.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const workerCode = "export const generation = 'retained';\n";
const stat = fsSync.statSync;
const read = (file: string) => fs.readFile(file, "utf8");
const exists = fsSync.existsSync;
async function writeFile(root: string, relative: string, content: string | Buffer) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
const inode = (file: string) => {
  const { dev, ino } = fsSync.statSync(file);
  return [dev, ino];
};
const manifest = (id: string, extra = {}) =>
  JSON.stringify({ id, configSchema: { type: "object" }, ...extra });
const assets = async (root: string, controlUi: Parameters<typeof readPluginControlUiAssets>[1]) => [
  ...(await readPluginControlUiAssets(root, controlUi)).assets.keys(),
];
function afterFsOperation(
  method: "mkdir" | "readFile" | "lstat",
  target: string,
  after: () => void,
) {
  const original = fs[method];
  vi.spyOn(fs, method).mockImplementation(async (...args: Parameters<typeof original>) => {
    let succeeded = false;
    try {
      const result = await Reflect.apply(original, fs, args);
      succeeded = true;
      return result;
    } finally {
      if (args[0] === target && (succeeded || method === "lstat")) {
        after();
      }
    }
  });
}
function beforeLink(check: (source: string) => void) {
  const link = fs.link;
  return vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
    check(String(source));
    return await link(source, destination);
  });
}

async function fixture(setup?: (source: string) => Promise<void>) {
  const root = await fs.realpath(dirs.make("retained-runtime-link-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "retained");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "package");
  await fs.mkdir(candidateRoot);
  const worker = await writeFile(source, "dist/state/worker.js", workerCode);
  await fs.chmod(worker, 0o444);
  // pnpm stores publish package files as hard links of one inode.
  await fs.link(worker, path.join(source, "dist", "worker-alias.js"));
  const launcher = await writeFile(
    source,
    "node_modules/.bin/tool",
    `#!/bin/sh\nexec "$basedir/../tool/cli.js"\n`,
  );
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
    retained: (relative: string) => path.join(destination, relative),
    original: (relative: string) => path.join(source, relative),
    projected: (entry: string) => path.join(destination, path.relative(source, entry)),
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

it("rejects hardlinked files larger than their inventory budget", async () => {
  const f = await fixture();
  await fs.chmod(f.worker, 0o644);
  await fs.appendFile(f.worker, "// grew after inventory\n");
  await expect(f.link()).rejects.toThrow("Plugin entry changed after snapshot inventory");
});

it.each(["matching", "size", "mode", "sha256"] as const)(
  "verifies changed-identity retained files (%s)",
  async (check) => {
    const f = await fixture(async (source) => {
      await writeFile(source, "dist/unique.js", workerCode);
    });
    const source = f.original("dist/unique.js");
    const originalMode = stat(source).mode & 0o7777;
    beforeLink((file) => {
      if (file !== source) {
        return;
      }
      fsSync.renameSync(source, `${source}.previous`);
      fsSync.writeFileSync(
        source,
        check === "size"
          ? `${workerCode}\n`
          : check === "sha256"
            ? workerCode.toUpperCase()
            : workerCode,
      );
      fsSync.chmodSync(source, check === "mode" ? originalMode ^ 0o100 : originalMode);
    });
    const result = await f.link();
    if (check === "matching") {
      expect(result).not.toHaveProperty("unusableReason");
      expect(await read(f.retained("dist/unique.js"))).toBe(workerCode);
      expect(inode(f.retained("dist/unique.js"))).not.toEqual(inode(`${source}.previous`));
    } else {
      expect(result).toMatchObject({
        unusableReason: `Retained runtime verification failed (${check}): ${source}`,
      });
    }
  },
);

it("keeps same-inode source edits on the fast path without hashing again", async () => {
  const f = await fixture();
  const hash = vi.spyOn(fileDescriptor, "hashFileMutationSnapshotSync");
  await fs.chmod(f.worker, 0o644);
  await fs.writeFile(f.worker, workerCode.toUpperCase());
  await expect(f.link()).resolves.not.toHaveProperty("unusableReason");
  expect(hash).not.toHaveBeenCalled();
  expect(inode(f.retained("dist/state/worker.js"))).toEqual(inode(f.worker));
});

it.each([false, true])(
  "preserves plugin safety (existing manifest twin=%s)",
  async (existingTwin) => {
    const controlUi = { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] };
    const nestedBrowser = "dist/control-ui/@scope/nested";
    const files = new Map(
      Object.entries({
        "openclaw.plugin.json": manifest("fixture", {
          providerCatalogEntry: "src/catalog.ts",
          capabilityCatalogEntry: "src/capabilities.ts",
          skills: ["./skills"],
          controlUi,
          themes: [
            {
              id: "fixture",
              name: "Fixture",
              description: "Fixture palette",
              source: "theme.json",
              icons: { rocket: "assets/rocket.svg" },
              hats: { beret: "assets/beret.svg" },
              critters: { ferris: { source: "assets/ferris.svg" } },
            },
          ],
        }),
        "package.json": JSON.stringify({
          name: "fixture",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup.ts",
            runtimeSetupEntry: "./dist/setup.js",
          },
        }),
        "index.ts": "export default { id: 'fixture', register() {} };\n",
        "dist/index.js": "export default { id: 'fixture', register() {} };\n",
        "setup.ts": "export const setup = {};\n",
        "dist/setup.js": "export const setup = {};\n",
        "src/catalog.ts": "export const providers = [];\n",
        "src/catalog.js": "export const providers = [];\n",
        "src/capabilities.ts": "export const capabilities = {};\n",
        "skills/fixture/SKILL.md":
          "---\nname: fixture\ndescription: Retained runtime fixture\n---\n",
        "provider-policy-api.ts": "export const policy = {};\n",
        "assets/icon.png": "fixture icon",
        "assets/activity.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "assets/activity/tool.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "theme.json": "{}",
        "assets/rocket.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "assets/beret.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "assets/ferris.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "dist/control-ui/index.js": "export {};\n",
        "dist/control-ui/chunks/shared.js": "export {};\n",
        "dist/control-ui/theme.css": ":root {}\n",
        "dist/control-ui/icons/openclaw.plugin.json": manifest("icons"),
        "dist/control-ui/icons/assets/activity/shared.js": "export {};\n",
        [`${nestedBrowser}/openclaw.plugin.json`]: manifest("nested", {
          controlUi: { entry: "dist/control-ui/index.js" },
        }),
        [`${nestedBrowser}/dist/control-ui/index.js`]: "export {};\n",
        "node_modules/native-addon/package.json": JSON.stringify({
          name: "native-addon",
          version: "1.0.0",
          main: "addon.node",
        }),
      }),
    );
    const payloads = [
      "assets/large-model.bin",
      "lib/implementation.js",
      "data/payload.json",
      "node_modules/native-addon/addon.node",
      "dist/control-ui/README.txt",
    ];
    const relativePlugin = path.join("extensions", "fixture");
    const f = await fixture(async (source) => {
      for (const [relativePath, content] of files) {
        await writeFile(source, path.join(relativePlugin, relativePath), content);
      }
      for (const relative of payloads) {
        await writeFile(
          source,
          path.join(relativePlugin, relative),
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
          expect(stat(path.join(rootDir, relativePath)).nlink).toBe(preexistingHardlink ? 2 : 1);
          const file = readPluginCacheFile({ rootDir, relativePath, rejectHardlinks: true });
          expect(file.ok).toBe(!preexistingHardlink);
          expect(fsSync.readFileSync(path.join(rootDir, relativePath), "utf8")).toBe(content);
          if (relativePath === "node_modules/native-addon/package.json") {
            const relative = path.join(relativePlugin, relativePath);
            expect(inode(f.retained(relative))).not.toEqual(inode(f.original(relative)));
          }
        }
      });
      expect(await assets(rootDir, controlUi)).toEqual(
        expect.arrayContaining([
          "index.js",
          "chunks/shared.js",
          "theme.css",
          "icons/assets/activity/shared.js",
        ]),
      );
      expect(await assets(path.join(rootDir, nestedBrowser), { entry: controlUi.entry })).toEqual([
        "index.js",
      ]);
    }
    expect(counts).toEqual({ linked: payloads.length + 2, copied: files.size + 1 });
    expect(link).toHaveBeenCalledTimes(payloads.length + 2);
    for (const relative of payloads) {
      const original = stat(f.original(path.join(relativePlugin, relative)));
      const retained = stat(f.retained(path.join(relativePlugin, relative)));
      expect(retained.ino).toBe(original.ino);
      expect(original.nlink).toBe(2);
      expect(retained).toMatchObject({ nlink: 2, size: original.size });
    }
    const sourcePlugin = path.join(f.source, relativePlugin);
    await fs.link(
      path.join(sourcePlugin, "openclaw.plugin.json"),
      path.join(f.source, "foreign-manifest.json"),
    );
    expect(stat(path.join(sourcePlugin, "openclaw.plugin.json")).nlink).toBe(existingTwin ? 3 : 2);
    expect(
      withPluginCache(createPluginCache(), () => loadPluginManifest(sourcePlugin)),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsafe plugin manifest path"),
    });
  },
);

it.each(["native", "portable-copy", "fallback-first", "fallback-second"] as const)(
  "retains admitted files and modes through replacement using %s",
  async (mode) => {
    const portable = mode === "portable-copy";
    const nestedFiles = portable
      ? Array.from({ length: 8 }, (_, index) =>
          path.join("node_modules", "fixture", "dist", "deep", "chunks", `part-${index}.js`),
        )
      : [];
    const f = await fixture(async (source) => {
      if (mode === "native") {
        await writeFile(source, "dist/unique.js", "export const retained = true;\n");
      }
      for (const file of nestedFiles) {
        const destination = await writeFile(source, file, `// ${file}\n`);
        await fs.chmod(destination, 0o444);
      }
      if (portable) {
        await fs.chmod(path.dirname(path.join(source, nestedFiles[0]!)), 0o751);
      }
    });
    const before = stat(f.worker, { bigint: true });
    let fallback: string | undefined;
    beforeLink((source) => {
      if (portable || source === fallback) {
        throw Object.assign(new Error("hard link unavailable"), {
          code: mode === "fallback-first" ? "EXDEV" : "EMLINK",
        });
      }
    });
    if (portable) {
      f.plan.entries.sort(
        (left, right) => Number(left.kind === "directory") - Number(right.kind === "directory"),
      );
    } else if (mode !== "native") {
      const sharedEntries = f.plan.entries.filter(
        (entry) => entry.kind === "file" && stat(entry.path, { bigint: true }).ino === before.ino,
      );
      f.plan.entries = [
        ...sharedEntries,
        ...f.plan.entries.filter((entry) => !sharedEntries.includes(entry)),
      ];
      fallback = sharedEntries[mode === "fallback-first" ? 0 : 1]!.path;
    }
    const counts = await (portable
      ? withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, f.link)
      : f.link());
    expect(counts).toEqual(
      portable
        ? { linked: 0, copied: 3 + nestedFiles.length }
        : { linked: fallback ? 1 : mode === "native" ? 3 : 2, copied: fallback ? 2 : 1 },
    );
    const retainedWorker = f.projected(fallback ?? f.worker);
    const retainedStat = stat(retainedWorker, { bigint: true });
    if (mode === "native") {
      expect(retainedStat.ino).toBe(before.ino);
      expect(stat(f.retained("dist/worker-alias.js"), { bigint: true }).ino).toBe(before.ino);
    } else {
      expect(retainedStat.ino).not.toBe(before.ino);
    }
    expect(Number(retainedStat.mode & 0o777n)).toBe(0o444);
    for (const file of nestedFiles) {
      expect(await read(f.retained(file))).toBe(`// ${file}\n`);
      expect(stat(f.retained(file)).mode & 0o777).toBe(0o444);
    }
    if (portable) {
      expect(stat(path.dirname(f.retained(nestedFiles[0]!))).mode & 0o777).toBe(0o751);
    }
    const retainedLauncher = f.retained("node_modules/.bin/tool");
    expect(stat(retainedLauncher).ino).not.toBe(stat(f.launcher).ino);
    expect(await read(f.launcher)).toContain('"$basedir/../tool/cli.js"');
    expect(await fs.readlink(f.retained("node_modules/link.js"))).toBe(
      path.join("..", "dist/state/worker.js"),
    );
    const displaced = `${f.source}.previous`;
    await fs.rename(f.source, displaced);
    await fs.rm(displaced, { recursive: true });
    expect(await read(retainedWorker)).toBe(workerCode);
    if (mode === "native") {
      expect(await read(f.retained("dist/unique.js"))).toBe("export const retained = true;\n");
    }
  },
);

async function fileWindowFixture() {
  const f = await fixture(async (source) => {
    for (let index = 0; index < 9; index += 1) {
      await writeFile(source, `parallel/${index}.js`, `export default ${index};\n`);
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
  return { ...f, files };
}

it.each([false, true])(
  "settles a bounded file window before returning (failed=%s)",
  async (failed) => {
    const f = await fileWindowFixture();
    const failure = new Error("retained link failed");
    const link = fs.link;
    let active = 0;
    let maximum = 0;
    const attempted: string[] = [];
    vi.spyOn(fs, "link").mockImplementation(async (existing, destination) => {
      attempted.push(String(existing));
      if (failed && existing === f.files[1]!.path) {
        throw failure;
      }
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await link(existing, destination);
      } finally {
        active -= 1;
      }
    });
    const mkdir = vi.spyOn(fs, "mkdir");
    const operation = f.link();
    if (failed) {
      await expect(
        operation.catch((error: unknown) => {
          expect(active).toBe(0);
          throw error;
        }),
      ).rejects.toBe(failure);
      expect(attempted).not.toContain(f.files[4]!.path);
      expect(exists(f.retained("node_modules"))).toBe(false);
    } else {
      expect(await operation).toEqual({ linked: 11, copied: 1 });
      expect(maximum).toBe(4);
      expect(active).toBe(0);
      expect(
        mkdir.mock.calls.filter(([directory]) => directory === f.retained("parallel")),
      ).toHaveLength(1);
      for (const entry of f.files) {
        expect(stat(f.projected(entry.path)).ino).toBe(stat(entry.path).ino);
      }
    }
  },
);

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
    const retainedLauncher = f.retained("node_modules/.bin/tool");
    const alias = path.join(f.plan.privateRoot, "module-alias");
    const revoke = () => {
      current = false;
    };
    if (stage === "parent") {
      f.plan.entries.sort(
        (left, right) => Number(right.path === f.worker) - Number(left.path === f.worker),
      );
      afterFsOperation("mkdir", f.retained("dist/state"), revoke);
    } else if (stage === "relocation") {
      afterFsOperation("readFile", retainedLauncher, revoke);
    } else {
      f.plan.aliases.push([alias, f.destination]);
      afterFsOperation("lstat", alias, revoke);
    }
    await expect(
      f.link(() => {
        if (!current) {
          throw revoked;
        }
      }),
    ).rejects.toBe(revoked);
    if (stage === "relocation") {
      expect(await read(retainedLauncher)).toBe(await read(f.launcher));
    } else {
      expect(exists(stage === "alias" ? alias : f.retained("dist/state/worker.js"))).toBe(false);
    }
  },
);
