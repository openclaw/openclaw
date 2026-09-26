import assert from "node:assert/strict";
import fs, { mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { type RetainUpdateRuntime, withRetainedUpdateRuntime } from "./update-retained-runtime.js";

type Operations = { append: { input: string; output: string[] } };
const stores = new Set<SqliteWorkerStore<Operations>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);

it.each([false, true])(
  "preserves the update outcome when disposable runtime removal fails (failed=%s)",
  async (failed) => {
    const base = tempDirs.make("openclaw-retained-runtime-cleanup-");
    const root = await fixture(base, "npm");
    const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
    const original = new Error("original update failure");
    const remove = fs.rm;
    let denyRemoval = false;
    let directory: Parameters<typeof fs.rm>[0] | undefined;
    const receipt: { metrics?: Awaited<ReturnType<RetainUpdateRuntime>> } = {};
    const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (denyRemoval) {
        directory = args[0];
        denyRemoval = false;
        throw new Error("retained runtime removal denied");
      }
      return await remove(...args);
    });
    try {
      const result = withRetainedUpdateRuntime(moduleUrl, async (retain) => {
        receipt.metrics = await retain({
          mutationRoots: [root],
          timeoutMs: 30_000,
          assertCurrent() {},
        });
        denyRemoval = true;
        if (failed) {
          throw original;
        }
        return receipt.metrics;
      });
      if (failed) {
        await expect(result).rejects.toBe(original);
      } else {
        expect(await result).toBe(receipt.metrics);
      }
      assert.ok(receipt.metrics);
      expect(receipt.metrics.linked + receipt.metrics.copied).toBe(6);
      assert.ok(typeof directory === "string");
      expect(directory).toContain("openclaw-update-runtime-");
      expect((await stat(directory)).isDirectory()).toBe(true);
    } finally {
      cleanup.mockRestore();
      if (directory) {
        await remove(directory, { recursive: true, force: true });
      }
    }
  },
);

it("reports the retained runtime and reason when a borrowed worker cannot settle", async () => {
  const base = tempDirs.make("openclaw-retained-runtime-unsettled-");
  const root = await fixture(base, "npm");
  const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs"));
  const failure = new Error("native close unconfirmed");
  const log = path.join(base, "cleanup.log");
  await writeFile(log, "");
  const previousLoggerOverride = loggingState.overrideSettings;
  let retained: string | undefined;
  const receipt: { metrics?: Awaited<ReturnType<RetainUpdateRuntime>> } = {};
  try {
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: log });
    const operation = withRetainedUpdateRuntime(moduleUrl.href, async (retain) => {
      receipt.metrics = await retain({
        mutationRoots: [root],
        timeoutMs: 30_000,
        assertCurrent() {},
      });
      const directory = (await fs.readdir(base)).find((entry) =>
        entry.startsWith("openclaw-update-runtime-"),
      );
      assert.ok(directory);
      retained = path.join(base, directory);
      const { runtimeGeneration } = captureRuntimeWorkerSource(moduleUrl);
      assert.ok(runtimeGeneration);
      runtimeGeneration.retain({}, async () => {
        throw failure;
      });
    });
    await expect(operation).rejects.toMatchObject({ errors: [failure] });
    assert.ok(receipt.metrics);
    expect(receipt.metrics.linked + receipt.metrics.copied).toBe(6);
    assert.ok(retained);
    expect((await stat(retained)).isDirectory()).toBe(true);
    await flushLogger();
    expect(await readFile(log, "utf8")).toContain(
      JSON.stringify(
        `Runtime retained at ${retained}: retained updater workers did not settle; keep it until the workers stop`,
      ),
    );
  } finally {
    setLoggerOverride(previousLoggerOverride as Parameters<typeof setLoggerOverride>[0]);
  }
});

const backend = `
import { DatabaseSync } from "node:sqlite";
import { generation } from "../shared-old-hash.mjs";
export function createSqliteWorkerBackend(_input, { databasePath }) {
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE IF NOT EXISTS entries (value TEXT)");
  return {
    execute(command) {
      if (command.type !== "append") throw new Error("Unknown retained fixture command");
      db.prepare("INSERT INTO entries VALUES (?)").run(generation + ":" + command.input);
      return db.prepare("SELECT value FROM entries ORDER BY rowid").all().map(row => row.value);
    },
    close() { db.close(); }
  };
}
`;

async function fixture(
  base: string,
  layout: "npm" | "pnpm" | "pnpm-workspace" | "git" | "git-linked",
) {
  const root = layout.startsWith("pnpm")
    ? path.join(base, "global/node_modules/.pnpm/openclaw@1/node_modules/openclaw")
    : path.join(base, "openclaw");
  await mkdir(path.join(root, "dist/state"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", dependencies: { fixture: "1.0.0" } }),
  );
  await writeFile(path.join(root, "dist/updater.mjs"), "export {};\n");
  await writeFile(path.join(root, "dist/state/store.js"), backend);
  await writeFile(
    path.join(root, "dist/shared-old-hash.mjs"),
    'export { generation } from "fixture";\n',
  );
  const dependency =
    layout.startsWith("git") || layout === "pnpm-workspace"
      ? path.join(root, "packages/fixture")
      : layout === "pnpm"
        ? path.join(base, "global/node_modules/.pnpm/fixture@1/node_modules/fixture")
        : path.join(root, "node_modules/fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", exports: "./index.js" }),
  );
  await writeFile(path.join(dependency, "index.js"), 'export const generation = "retained";\n');
  if (layout !== "npm") {
    const modules =
      layout === "git-linked"
        ? path.join(base, "external-modules")
        : path.join(root, "node_modules");
    await mkdir(modules, { recursive: true });
    if (layout === "git-linked") {
      await symlink(
        modules,
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await symlink(
      dependency,
      path.join(root, "node_modules/fixture"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  if (layout === "git") {
    // Pulling a workspace retirement can leave ignored modules and a pnpm hoist link.
    const retired = path.join(root, "extensions/retired");
    const hoisted = path.join(root, "node_modules/.pnpm/node_modules");
    await mkdir(path.join(retired, "node_modules"), { recursive: true });
    await mkdir(path.join(hoisted, "@fixture"), { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(root, path.join(hoisted, "openclaw"), linkType);
    await symlink(retired, path.join(hoisted, "@fixture/retired"), linkType);
    await symlink(dependency, path.join(retired, "node_modules/fixture"), linkType);
  }
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git/private"), "unrelated checkout data");
  return root;
}

it.each(["npm", "pnpm", "pnpm-workspace", "git", "git-linked"] as const)(
  "retains %s worker chunks and dependencies through replacement and drains only its borrowers",
  async (layout) => {
    const base = tempDirs.make("openclaw-retained-runtime-");
    const root = await fixture(base, layout);
    const unrelatedRoot = await fixture(path.join(base, "unrelated"), "npm");
    const unrelated = await openSqliteWorkerStore<Operations>({
      moduleUrl: pathToFileURL(path.join(unrelatedRoot, "dist/state/store.js")),
      databasePath: path.join(base, "unrelated.sqlite"),
      input: undefined,
    });
    stores.add(unrelated);
    const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
    const worker = {
      currentModuleUrl: moduleUrl,
      sourceWorkerName: "store",
      distWorkerPath: "state/store.js",
    };
    let retainedPath: string | undefined;
    let retainedStore: SqliteWorkerStore<Operations> | undefined;
    let acceptedWrite: Promise<string[]> | undefined;
    await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
      const metrics = await retain({
        mutationRoots: [root],
        ...(layout.startsWith("pnpm")
          ? {
              installTarget: {
                manager: "pnpm" as const,
                command: "pnpm",
                globalRoot: path.join(base, "global/node_modules"),
                packageRoot: root,
              },
            }
          : {}),
        timeoutMs: 30_000,
        assertCurrent() {},
      });
      assert.ok(metrics);
      expect(metrics.inventoryMs).toBeGreaterThanOrEqual(0);
      expect(metrics.materializationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.linked + metrics.copied).toBe(6);
      expect(metrics.entries).toBeGreaterThan(6);
      expect(metrics.estimatedBytes).toBeGreaterThanOrEqual(metrics.entries * 4096);
      expect(
        await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} }),
      ).toBeUndefined();
      const source = captureRuntimeWorkerSource(resolveRuntimeWorkerUrl(worker));
      retainedPath = fileURLToPath(source.moduleUrl);
      expect(retainedPath).not.toBe(path.join(root, "dist/state/store.js"));
      const retainedRoot = path.resolve(path.dirname(retainedPath), "../..");
      await expect(stat(path.join(retainedRoot, ".git/private"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const displaced = `${root}.previous`;
      await rename(root, displaced);
      await mkdir(path.join(root, "dist/state"), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
      await writeFile(
        path.join(root, "dist/state/store.js"),
        'export function createSqliteWorkerBackend() { throw new Error("Target generation lacks append"); }',
      );
      await rm(displaced, { recursive: true });

      if (layout === "git") {
        const retired = path.join(retainedRoot, "node_modules/.pnpm/node_modules/@fixture/retired");
        expect(await fs.realpath(retired)).toBe(path.join(retainedRoot, "extensions/retired"));
        await expect(stat(path.join(retired, "package.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(path.join(retired, "node_modules/fixture/index.js"), "utf8")).toBe(
          'export const generation = "retained";\n',
        );
      }

      // Target-explicit requests keep their selected generation, even in the retained scope.
      await expect(
        openSqliteWorkerStore({
          moduleUrl: resolveRuntimeWorkerUrl({ ...worker, root }),
          databasePath: path.join(base, "target.sqlite"),
          input: undefined,
        }),
      ).rejects.toThrow("Target generation lacks append");
      if (layout === "pnpm") {
        await rm(path.join(base, "global/node_modules/.pnpm/fixture@1"), { recursive: true });
      }

      retainedStore = await openSqliteWorkerStore<Operations>({
        ...source,
        databasePath: path.join(base, "retained.sqlite"),
        input: undefined,
      });
      stores.add(retainedStore);
      expect(await retainedStore.execute({ type: "append", input: "first" })).toEqual([
        "retained:first",
      ]);
      // Scope cleanup must join this accepted native write before retiring its tree.
      acceptedWrite = retainedStore.execute({ type: "append", input: "second" });
      void acceptedWrite.catch(() => undefined);
    });
    assert.ok(retainedPath && retainedStore);
    await expect(readFile(retainedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await acceptedWrite).toEqual(["retained:first", "retained:second"]);
    await expect(retainedStore.execute({ type: "append", input: "escaped" })).rejects.toThrow();
    expect(await unrelated.execute({ type: "append", input: "still open" })).toEqual([
      "retained:still open",
    ]);
  },
);

it.each(["git", "alias", "ancestor", "npm", "pnpm10", "pnpm11", "bun"] as const)(
  "retains %s on the source filesystem outside the complete replacement boundary",
  async (layout) => {
    const base = await fs.realpath(tempDirs.make("openclaw-retained-placement-"));
    const temporary = path.join(base, "other-volume");
    await mkdir(temporary);
    const project = path.join(base, "installation");
    const globalRoot = path.join(
      project,
      layout === "pnpm10" ? "5/node_modules" : layout === "pnpm11" ? "v11" : "node_modules",
    );
    const packaged = ["npm", "pnpm10", "pnpm11", "bun"].includes(layout);
    const packageParent = packaged
      ? layout === "pnpm11"
        ? path.join(globalRoot, "group/node_modules")
        : globalRoot
      : project;
    const root = await fixture(packageParent, "npm");
    const alias = path.join(base, "alias");
    if (layout === "alias") {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    }
    const mutationRoot = layout === "ancestor" ? project : layout === "alias" ? alias : root;
    const replacementRoot =
      layout === "npm" ? globalRoot : packaged || layout === "ancestor" ? project : root;
    const installTarget: ResolvedGlobalInstallTarget | undefined = packaged
      ? {
          manager: layout === "bun" ? "bun" : layout === "npm" ? "npm" : "pnpm",
          command: "fixture",
          globalRoot,
          packageRoot: root,
        }
      : undefined;
    const moduleUrl = pathToFileURL(
      path.join(layout === "alias" ? alias : root, "dist/updater.mjs"),
    ).href;
    const original = path.join(root, "dist/state/store.js");
    const originalStat = await stat(original);
    const link = fs.link;
    const temporaryRoot = vi.spyOn(os, "tmpdir").mockReturnValue(temporary);
    const links = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      // A different temp volume rejects hard links; same-volume placement must avoid the copy.
      if (String(destination).startsWith(`${temporary}${path.sep}`)) {
        throw Object.assign(new Error("different filesystem"), { code: "EXDEV" });
      }
      return await link(source, destination);
    });
    let retained: string | undefined;
    try {
      await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
        await retain({
          mutationRoots: [mutationRoot],
          installTarget,
          env: { BUN_INSTALL_GLOBAL_DIR: project },
          timeoutMs: 30_000,
          assertCurrent() {},
        });
        const source = captureRuntimeWorkerSource(
          resolveRuntimeWorkerUrl({
            currentModuleUrl: moduleUrl,
            sourceWorkerName: "store",
            distWorkerPath: "state/store.js",
          }),
        );
        retained = fileURLToPath(source.moduleUrl);
        expect(retained.startsWith(`${replacementRoot}${path.sep}`)).toBe(false);
        expect(await stat(retained)).toMatchObject({
          dev: originalStat.dev,
          ino: originalStat.ino,
        });
        const previous = `${replacementRoot}.previous`;
        await rename(replacementRoot, previous);
        await rm(previous, { recursive: true });
        expect(await readFile(retained, "utf8")).toBe(backend);
        const store = await openSqliteWorkerStore<Operations>({
          ...source,
          databasePath: path.join(base, "retained.sqlite"),
          input: undefined,
        });
        stores.add(store);
        expect(await store.execute({ type: "append", input: "after replacement" })).toEqual([
          "retained:after replacement",
        ]);
      });
      assert.ok(retained);
      await expect(stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      links.mockRestore();
      temporaryRoot.mockRestore();
    }
  },
);

it.each(["EACCES", "EROFS"])(
  "falls back when the runtime sibling is unavailable (%s)",
  async (code) => {
    const base = await fs.realpath(tempDirs.make("openclaw-retained-fallback-"));
    const root = await fixture(base, "npm");
    const temporary = path.join(base, "temporary");
    await mkdir(temporary);
    const makeTemp = fs.mkdtemp;
    const temporaryRoot = vi.spyOn(os, "tmpdir").mockReturnValue(temporary);
    const allocation = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      if (path.dirname(args[0]) === base) {
        throw Object.assign(new Error("sibling is unavailable"), { code });
      }
      return await makeTemp(...args);
    });
    const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
    let retained: string | undefined;
    try {
      await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
        await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
        retained = fileURLToPath(
          captureRuntimeWorkerSource(
            resolveRuntimeWorkerUrl({
              currentModuleUrl: moduleUrl,
              sourceWorkerName: "store",
              distWorkerPath: "state/store.js",
            }),
          ).moduleUrl,
        );
        expect(retained.startsWith(`${temporary}${path.sep}`)).toBe(true);
        expect(await readFile(retained, "utf8")).toBe(backend);
      });
      assert.ok(retained);
      await expect(stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allocation.mockRestore();
      temporaryRoot.mockRestore();
    }
  },
);
