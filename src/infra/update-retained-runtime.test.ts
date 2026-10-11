import "../../test/helpers/private-update-handoff-store.js";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs, { mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import * as processCensus from "./openclaw-process-census.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import * as temporaryArtifacts from "./temp-artifact-cleanup.js";
import { runUpdateStateInspectionWorker } from "./update-candidate-state.inspection.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { type RetainUpdateRuntime, withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const inspectionFixture = vi.hoisted(() => ({ moduleUrl: "" }));
vi.mock("./runtime-process-entrypoints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-process-entrypoints.js")>();
  return {
    ...actual,
    runtimeProcessEntrypoints: {
      ...actual.runtimeProcessEntrypoints,
      updateCandidateState: {
        ...actual.runtimeProcessEntrypoints.updateCandidateState,
        get currentModuleUrl() {
          return (
            inspectionFixture.moduleUrl ||
            actual.runtimeProcessEntrypoints.updateCandidateState.currentModuleUrl
          );
        },
      },
    },
  };
});

afterEach(() => {
  inspectionFixture.moduleUrl = "";
  vi.restoreAllMocks();
});

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

it.for([false, true])(
  "defers runtime deletion until eligible maintenance without losing settled work (failed=%s)",
  async (failed, { signal }) => {
    const base = await fs.realpath(tempDirs.make("openclaw-retained-runtime-cleanup-"));
    const root = await fixture(base, "npm");
    const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
    const original = new Error("original update failure");
    const entered = createDeferred();
    const release = createDeferred();
    const removed = vi.spyOn(fs, "rm");
    const reportRetained = vi.spyOn(temporaryArtifacts, "reportRetainedUpdateRuntime");
    vi.spyOn(os, "tmpdir").mockReturnValue(base);
    vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
    let directory: string | undefined;
    let store: SqliteWorkerStore<Operations> | undefined;
    let acceptedWrite: Promise<string[]> | undefined;
    let resourcesSettled = false;
    const receipt: { metrics?: Awaited<ReturnType<RetainUpdateRuntime>> } = {};
    const assertResourcesSettled = vi.fn(() => expect(resourcesSettled).toBe(true));
    const maintain = () =>
      temporaryArtifacts.maintainRetainedUpdateRuntimes({
        packageRoots: [root],
        repair: true,
        assertCurrent() {},
        assertResourcesSettled,
      });
    const result = withRetainedUpdateRuntime(moduleUrl, async (retain) => {
      receipt.metrics = await retain({
        mutationRoots: [root],
        timeoutMs: 30_000,
        assertCurrent() {},
      });
      const name = (await fs.readdir(base)).find((entry) =>
        entry.startsWith("openclaw-update-runtime-"),
      );
      assert.ok(name);
      directory = path.join(base, name);
      const source = captureRuntimeWorkerSource(
        pathToFileURL(path.join(root, "dist/state/store.js")),
      );
      assert.ok(source.runtimeGeneration);
      store = await openSqliteWorkerStore<Operations>({
        ...source,
        databasePath: path.join(base, "retained.sqlite"),
        input: undefined,
      });
      stores.add(store);
      source.runtimeGeneration.retain({}, async () => {
        entered.resolve();
        await release.promise;
        resourcesSettled = true;
      });
      acceptedWrite = store.execute({ type: "append", input: "accepted before exit" });
      void acceptedWrite.catch(() => undefined);
      if (failed) {
        throw original;
      }
      return receipt.metrics;
    });
    const settled = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          settled,
          "Updater returned before worker settlement",
        ),
        signal,
      );
      expect(await maintain()).toContainEqual(
        expect.stringContaining("the creating update still owns this runtime"),
      );
      expect(assertResourcesSettled).not.toHaveBeenCalled();
      assert.ok(directory);
      expect((await stat(directory)).isDirectory()).toBe(true);
    } finally {
      release.resolve();
      await settled;
    }
    expect(await settled).toEqual(failed ? { error: original } : { value: receipt.metrics });
    expect(resourcesSettled).toBe(true);
    expect(await acceptedWrite).toEqual(["retained:accepted before exit"]);
    assert.ok(directory && store);
    await expect(store.execute({ type: "append", input: "escaped" })).rejects.toThrow();
    expect(removed.mock.calls.some(([target]) => String(target) === directory)).toBe(false);
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(reportRetained).toHaveBeenCalledWith(
      directory,
      expect.stringContaining("worker generation settled; cleanup deferred"),
    );
    expect(await maintain()).toContain(`Removed abandoned updater runtime: ${directory}`);
    expect(assertResourcesSettled).toHaveBeenCalledOnce();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "dist/state/store.js"), "utf8")).toBe(backend);
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
  layout: "npm" | "pnpm" | "pnpm-workspace" | "git" | "git-linked" | "git-modules",
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
  if (layout === "git" || layout === "git-modules") {
    // Pulling a workspace retirement can leave ignored modules and a pnpm hoist link.
    const retired = path.join(root, "extensions/retired");
    const hoisted = path.join(root, "node_modules/.pnpm/node_modules");
    await mkdir(path.join(retired, "node_modules"), { recursive: true });
    await mkdir(path.join(hoisted, "@fixture"), { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(root, path.join(hoisted, "openclaw"), linkType);
    await symlink(
      layout === "git-modules" ? path.join(retired, "node_modules") : retired,
      path.join(hoisted, "@fixture/retired"),
      linkType,
    );
    await symlink(dependency, path.join(retired, "node_modules/fixture"), linkType);
  }
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git/private"), "unrelated checkout data");
  return root;
}

it.each(
  ["control", "anchor", "superseded"].flatMap((kind) =>
    [false, true].map((explicitLink) => ({ kind, explicitLink })),
  ),
)(
  "leaves package recovery $kind untouched during runtime retention (explicitLink=$explicitLink)",
  async ({ kind, explicitLink }) => {
    const root = await fixture(tempDirs.make("retained-recovery-boundary-"), "npm");
    const anchor = resolvePackageActivationAnchor(path.join(root, "node_modules/openclaw"));
    const recoveryRoot =
      kind === "control"
        ? resolvePackageActivationControl(anchor)
        : kind === "anchor"
          ? anchor
          : `${anchor}.superseded-00000000-0000-4000-8000-000000000001`;
    const recoveryFile = path.join(
      recoveryRoot,
      kind === "control" ? "operation.sqlite" : "previous/dist/entry.js",
    );
    await mkdir(path.dirname(recoveryFile), { recursive: true, mode: 0o700 });
    await writeFile(recoveryFile, "preserved recovery evidence", { mode: 0o600 });
    const before = await fs.lstat(recoveryFile, { bigint: true });
    const assets = [
      path.join("node_modules", "runtime.control", "asset.sqlite"),
      path.join("node_modules", `${path.basename(anchor)}.notes`, "asset.sqlite"),
      path.join("node_modules", `${path.basename(anchor)}.superseded-not-a-uuid`, "asset.sqlite"),
      path.join("dist", path.basename(recoveryRoot), "asset.sqlite"),
    ];
    for (const relative of assets) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), "runtime asset");
    }
    if (explicitLink) {
      await symlink(recoveryFile, path.join(root, "dist/recovery-link"));
    }
    const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs"));
    const operation = withRetainedUpdateRuntime(moduleUrl.href, async (retain) => {
      await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
      const retained = fileURLToPath(captureRuntimeWorkerSource(moduleUrl).moduleUrl);
      expect(retained).not.toBe(fileURLToPath(moduleUrl));
      const retainedRoot = path.resolve(path.dirname(retained), "..");
      for (const relative of assets) {
        expect(await readFile(path.join(retainedRoot, relative), "utf8")).toBe("runtime asset");
      }
      expect(await fs.lstat(recoveryFile, { bigint: true })).toMatchObject({
        nlink: before.nlink,
        ctimeNs: before.ctimeNs,
      });
      expect(fsSync.existsSync(path.join(retainedRoot, path.relative(root, recoveryRoot)))).toBe(
        false,
      );
    });
    if (explicitLink) {
      await expect(operation).rejects.toThrow(
        "Package recovery state cannot be a runtime dependency",
      );
    } else {
      await operation;
    }
    expect(await readFile(recoveryFile, "utf8")).toBe("preserved recovery evidence");
    // Old sealed helpers hash these fields: hard-linking identical bytes still
    // invalidates their recovery fingerprint, even after the link is removed.
    expect(await fs.lstat(recoveryFile, { bigint: true })).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink,
      ctimeNs: before.ctimeNs,
    });
  },
);

it("runs default inspection from the retained updater and explicit inspection from the target", async () => {
  const base = await fs.realpath(tempDirs.make("retained-inspection-transport-"));
  const root = await fixture(base, "npm");
  const worker = path.join(root, "dist/infra/update-candidate-state.worker.js");
  await mkdir(path.dirname(worker));
  const transport = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ generation, mode: JSON.parse(input).mode }));
`;
  await writeFile(worker, `import { generation } from "../shared-old-hash.mjs";\n${transport}`);
  inspectionFixture.moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
  await withRetainedUpdateRuntime(inspectionFixture.moduleUrl, async (retain) => {
    await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
    await rename(root, `${root}.previous`);
    await mkdir(path.dirname(worker), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
    await writeFile(worker, `const generation = "candidate";\n${transport}`);

    const inspect = (selectedRoot?: string) =>
      runUpdateStateInspectionWorker({
        input: { mode: "database-restore-preparation", stateDir: base, config: {} },
        nodeRunner: process.execPath,
        root: selectedRoot,
        sourceEnv: { ...process.env, HOME: base, USERPROFILE: base },
        stagingRoot: base,
        databases: [],
      });
    const original = await inspect();
    const target = await inspect(root);
    expect(original).toMatchObject({ code: 0, termination: "exit" });
    expect(target).toMatchObject({ code: 0, termination: "exit" });
    expect([JSON.parse(original.stdout), JSON.parse(target.stdout)]).toEqual([
      { generation: "retained", mode: "database-restore-preparation" },
      { generation: "candidate", mode: "database-restore-preparation" },
    ]);
  });
});

it.each([".git", "extensions/retired", "extensions/linked-residue"])(
  "refuses unrelated host files reached through a hoist link to %s",
  async (directory) => {
    const root = await fixture(tempDirs.make("openclaw-retained-host-link-"), "git");
    const target = path.join(root, directory);
    const linkedModules = directory === "extensions/linked-residue";
    if (linkedModules) {
      await mkdir(target);
      await symlink(
        path.join(root, ".git"),
        path.join(target, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const marker = linkedModules
      ? path.join(root, ".git/private")
      : path.join(target, "private.txt");
    await writeFile(marker, "unrelated checkout data");
    const link = path.join(
      root,
      "node_modules/.pnpm/node_modules",
      directory === "extensions/retired" ? "@fixture/retired" : "unrelated",
    );
    if (directory !== "extensions/retired") {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    }
    await expect(
      withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, (retain) =>
        retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} }),
      ),
    ).rejects.toThrow(`Cannot privately copy host-owned plugin link ${link} -> ${target}`);
    expect(await readFile(marker, "utf8")).toBe("unrelated checkout data");
  },
);

it("refuses files added between residue selection and inventory", async () => {
  const root = await fixture(tempDirs.make("openclaw-retained-residue-inventory-"), "git");
  const residue = path.join(root, "extensions/retired");
  const marker = path.join(residue, "private.txt");
  const reads = vi.spyOn(fs, "readdir");
  let inserted = false;
  try {
    await expect(
      withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, (retain) =>
        retain({
          mutationRoots: [root],
          timeoutMs: 30_000,
          assertCurrent() {
            if (!inserted && reads.mock.calls.some(([directory]) => directory === residue)) {
              fsSync.writeFileSync(marker, "late unrelated host data");
              inserted = true;
            }
          },
        }),
      ),
    ).rejects.toThrow("Retired workspace changed during runtime retention");
    expect(inserted).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("late unrelated host data");
  } finally {
    reads.mockRestore();
  }
});

it.each(["npm", "pnpm", "pnpm-workspace", "git", "git-linked", "git-modules"] as const)(
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

      if (layout === "git" || layout === "git-modules") {
        const retired = path.join(retainedRoot, "node_modules/.pnpm/node_modules/@fixture/retired");
        const modulePath =
          layout === "git-modules" ? "fixture/index.js" : "node_modules/fixture/index.js";
        if (layout === "git") {
          expect(await fs.realpath(retired)).toBe(path.join(retainedRoot, "extensions/retired"));
          await expect(stat(path.join(retired, "package.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(await readFile(path.join(retired, modulePath), "utf8")).toBe(
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
      // Deferring tree deletion must still join accepted native writes.
      acceptedWrite = retainedStore.execute({ type: "append", input: "second" });
      void acceptedWrite.catch(() => undefined);
    });
    assert.ok(retainedPath && retainedStore);
    expect(await readFile(retainedPath, "utf8")).toBe(backend);
    expect(await acceptedWrite).toEqual(["retained:first", "retained:second"]);
    await expect(retainedStore.execute({ type: "append", input: "escaped" })).rejects.toThrow();
    expect(await unrelated.execute({ type: "append", input: "still open" })).toEqual([
      "retained:still open",
    ]);
  },
);

it("refuses unsafe fallback storage without changing the installed runtime", async () => {
  const base = tempDirs.make("retained-owner-refusal-");
  const owner = path.join(base, "manager-project");
  const globalRoot = path.join(owner, "v11");
  const root = await fixture(globalRoot, "npm");
  const temporary = path.join(owner, "scratch");
  await mkdir(temporary);
  vi.spyOn(os, "tmpdir").mockReturnValue(temporary);
  const allocate = fs.mkdtemp;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
    if (args[0].startsWith(path.join(base, "openclaw-update-runtime-"))) {
      throw Object.assign(new Error("fixture parent read-only"), { code: "EROFS" });
    }
    return allocate(...args);
  });
  const original = await readFile(path.join(root, "dist/state/store.js"), "utf8");
  const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
  await expect(
    withRetainedUpdateRuntime(moduleUrl, async (retain) => {
      await retain({
        mutationRoots: [root],
        installTarget: { manager: "pnpm", command: "pnpm", globalRoot, packageRoot: root },
        timeoutMs: 30_000,
        assertCurrent() {},
      });
    }),
  ).rejects.toThrow("Updater temporary directory is inside an installation being replaced");
  expect(await readFile(path.join(root, "dist/state/store.js"), "utf8")).toBe(original);
  expect(await fs.readdir(base)).toEqual(["manager-project"]);
});

it.each(["git", "alias", "ancestor", "npm", "pnpm10", "pnpm11", "bun", "bun-no-env"] as const)(
  "retains %s on the source filesystem outside the complete replacement boundary",
  async (layout) => {
    const base = await fs.realpath(tempDirs.make("openclaw-retained-placement-"));
    const project = path.join(base, "installation");
    const globalRoot = path.join(
      project,
      layout === "pnpm10" ? "5/node_modules" : layout === "pnpm11" ? "v11" : "node_modules",
    );
    const packaged = ["npm", "pnpm10", "pnpm11", "bun", "bun-no-env"].includes(layout);
    const packageParent = packaged
      ? layout === "pnpm11"
        ? path.join(globalRoot, "group/node_modules")
        : globalRoot
      : project;
    const root = await fixture(packageParent, "npm");
    const temporary = path.join(packaged && layout !== "npm" ? project : base, "scratch");
    await mkdir(temporary);
    const alias = path.join(base, "alias");
    if (layout === "alias") {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    }
    const mutationRoot = layout === "ancestor" ? project : layout === "alias" ? alias : root;
    const replacementRoot =
      layout === "npm" ? globalRoot : packaged || layout === "ancestor" ? project : root;
    const installTarget: ResolvedGlobalInstallTarget | undefined = packaged
      ? {
          manager: layout.startsWith("bun") ? "bun" : layout === "npm" ? "npm" : "pnpm",
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
    let retainedStore: SqliteWorkerStore<Operations> | undefined;
    try {
      await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
        await retain({
          mutationRoots: [mutationRoot],
          installTarget,
          env: layout === "bun-no-env" ? {} : { BUN_INSTALL_GLOBAL_DIR: project },
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
        retainedStore = store;
        stores.add(store);
        expect(await store.execute({ type: "append", input: "after replacement" })).toEqual([
          "retained:after replacement",
        ]);
      });
      assert.ok(retained && retainedStore);
      expect(await readFile(retained, "utf8")).toBe(backend);
      await expect(retainedStore.execute({ type: "append", input: "escaped" })).rejects.toThrow();
    } finally {
      links.mockRestore();
      temporaryRoot.mockRestore();
    }
  },
);

it("retains and reclaims the runtime when the install is spelled unlike its native realpath", async ({
  skip,
}) => {
  // Windows 8.3 names (C:\Users\RUNNER~1) and case-insensitive volumes give one
  // directory several spellings; native realpath returns only the on-disk one.
  const base = await fs.realpath(tempDirs.make("openclaw-retained-spelling-"));
  const root = await fixture(path.join(base, "Profile"), "npm");
  const aliasRoot = path.join(base, "profile", path.relative(path.join(base, "Profile"), root));
  if (!fsSync.existsSync(aliasRoot) || fsSync.realpathSync.native(aliasRoot) !== root) {
    skip("the temporary volume is case-sensitive");
  }
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
  vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const maintain = () =>
    temporaryArtifacts.maintainRetainedUpdateRuntimes({
      packageRoots: [aliasRoot],
      repair: true,
      assertCurrent() {},
    });
  const moduleUrl = pathToFileURL(path.join(aliasRoot, "dist/updater.mjs")).href;
  const directory = await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
    expect(
      await retain({ mutationRoots: [aliasRoot], timeoutMs: 30_000, assertCurrent() {} }),
    ).toMatchObject({ entries: expect.any(Number) });
    const retained = fileURLToPath(
      captureRuntimeWorkerSource(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: moduleUrl,
          sourceWorkerName: "store",
          distWorkerPath: "state/store.js",
        }),
      ).moduleUrl,
    );
    const [name = ""] = path.relative(path.join(base, "Profile"), retained).split(path.sep);
    expect(name).toMatch(/^openclaw-update-runtime-/u);
    expect(await readFile(retained, "utf8")).toBe(backend);
    expect(await maintain()).toContainEqual(
      expect.stringContaining("the creating update still owns this runtime"),
    );
    return path.join(base, "Profile", name);
  });
  expect(await maintain()).toContain(`Removed abandoned updater runtime: ${directory}`);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("falls back when the runtime sibling is read-only", async () => {
  const base = await fs.realpath(tempDirs.make("openclaw-retained-fallback-"));
  const root = await fixture(base, "npm");
  const temporary = path.join(base, "temporary");
  await mkdir(temporary);
  const makeTemp = fs.mkdtemp;
  const temporaryRoot = vi.spyOn(os, "tmpdir").mockReturnValue(temporary);
  const allocation = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
    if (path.dirname(args[0]) === base) {
      throw Object.assign(new Error("sibling is unavailable"), { code: "EROFS" });
    }
    return await makeTemp(...args);
  });
  const moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
  let retained: string | undefined;
  let generation: ReturnType<typeof captureRuntimeWorkerSource>["runtimeGeneration"];
  try {
    await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
      await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
      const source = captureRuntimeWorkerSource(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: moduleUrl,
          sourceWorkerName: "store",
          distWorkerPath: "state/store.js",
        }),
      );
      retained = fileURLToPath(source.moduleUrl);
      generation = source.runtimeGeneration;
      expect(retained.startsWith(`${temporary}${path.sep}`)).toBe(true);
      expect(await readFile(retained, "utf8")).toBe(backend);
    });
    assert.ok(retained && generation);
    expect(await readFile(retained, "utf8")).toBe(backend);
    expect(() => generation!.resolve(pathToFileURL(retained!))).toThrow("generation is closing");
  } finally {
    allocation.mockRestore();
    temporaryRoot.mockRestore();
  }
});
