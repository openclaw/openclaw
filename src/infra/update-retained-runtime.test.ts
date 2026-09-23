import assert from "node:assert/strict";
import fs, { mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

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
        await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
        denyRemoval = true;
        if (failed) {
          throw original;
        }
        return { status: "ok" };
      });
      if (failed) {
        await expect(result).rejects.toBe(original);
      } else {
        await expect(result).resolves.toEqual({ status: "ok" });
      }
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

it("retains the runtime and its original error when a borrowed worker cannot settle", async () => {
  const failure = new Error("native close unconfirmed");
  const release = vi.fn(async () => {});
  const retained = pathToFileURL(path.resolve("retained-runtime/backend.mjs"));
  const operation = withRuntimeWorkerGeneration(
    async (bind) => {
      bind(() => retained);
      const generation = captureRuntimeWorkerSource(
        pathToFileURL(path.resolve("original/backend.mjs")),
      ).runtimeGeneration;
      assert.ok(generation);
      generation.retain({}, async () => {
        throw failure;
      });
    },
    release,
    () => path.dirname(fileURLToPath(retained)),
  );
  await expect(operation).rejects.toMatchObject({
    message: expect.stringContaining(path.dirname(fileURLToPath(retained))),
    errors: [failure],
  });
  expect(release).not.toHaveBeenCalled();
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
      await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
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
