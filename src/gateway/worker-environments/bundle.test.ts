import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../shared/worker-bundle-hash.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  createWorkerBundleProducer,
  resolveWorkerNpmInstallationArtifact,
  type WorkerInstallationArtifact,
} from "./bundle.js";
import type { WorkerBundleBuildOptions } from "./node-bootstrap-artifact-contract.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";
import { workerWorkspaceRsyncReceiverEntryPath } from "./workspace-sync-helpers.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

const ARTIFACTS = {
  ...Object.fromEntries(
    WORKER_BUNDLE_ARTIFACT_PATHS.toSorted().map((name) => [name, `fixture: ${name}\n`]),
  ),
  "worker.mjs": "export const worker = true;\n",
};

const artifactPath = (root: string, name = "worker.mjs") => path.join(root, "dist/worker", name);
const readText = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectPresent = (file: string) => expect(fs.stat(file)).resolves.toBeDefined();

function producer(
  packageRoot: string,
  cacheDir: string,
  options: Parameters<typeof createWorkerBundleProducer>[0] = {},
) {
  return createWorkerBundleProducer({ packageRoot, cacheDir, ...options });
}

function withBundleFixture(
  run: (fixture: { root: string; packageRoot: string; cacheDir: string }) => Promise<void>,
) {
  return withTestDir({ prefix: "openclaw-worker-bundle-" }, (root) =>
    run({ root, packageRoot: path.join(root, "package"), cacheDir: path.join(root, "cache") }),
  );
}

// mock-isolation: keep staging fault injection beside the builder; the worker suite covers isolation.
vi.mock("./node-bootstrap-artifact-worker.js", () => ({
  prepareNodeArtifactInWorker: async (_kind: "bundle", options: WorkerBundleBuildOptions) => {
    const { prepareWorkerBundle } = await import("./bundle.js");
    return await prepareWorkerBundle(options);
  },
}));

async function writeFixture(
  packageRoot: string,
  workerSource = "export const worker = true;\n",
  chunkCount = 0,
): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "openclaw",
      version: "1.2.3",
      type: "module",
      dependencies: { json5: "2.2.3" },
      scripts: { postinstall: "node scripts/postinstall.mjs" },
    })}\n`,
    "utf8",
  );
  for (const [artifactName, contents] of Object.entries({
    ...ARTIFACTS,
    "worker.mjs": workerSource,
  })) {
    await fs.writeFile(artifactPath(packageRoot, artifactName), contents, {
      encoding: "utf8",
      mode: 0o755,
    });
  }
  for (let index = 0; index < chunkCount; index++) {
    await fs.writeFile(
      path.join(packageRoot, "dist/worker", `worker-chunk-${index}.mjs`),
      `export const value = ${index};${" ".repeat(index)}\n`,
    );
  }
}

async function listTarball(tarballPath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file: tarballPath,
    onReadEntry(entry) {
      entries.push(entry.path);
    },
  });
  return entries;
}

function bundleArtifact(overrides: Partial<WorkerBundleArtifact> = {}): WorkerBundleArtifact {
  return {
    install: "bundle",
    bundleHash: "a".repeat(64),
    openclawVersion: "1.2.3",
    protocolFeatures: [],
    tarballBytes: 1,
    tarballSha256: "b".repeat(64),
    tarballPath: "/tmp/openclaw-worker.tgz",
    ...overrides,
  };
}

describe("worker bundle producer", () => {
  it("reuses a packaged worker graph through a package-root symlink without creating a cache", async () => {
    await withTestDir({ prefix: "openclaw-worker-packaged-" }, async (root) => {
      const sourceRoot = path.join(root, "source");
      await writeFixture(sourceRoot, 'export { value } from "./worker-chunk-runtime.mjs";');
      await fs.writeFile(
        path.join(sourceRoot, "dist/worker/worker-chunk-runtime.mjs"),
        "export const value = 1;",
      );
      const built = await producer(sourceRoot, path.join(root, "source-cache")).prepare();

      const installedRoot = path.join(root, "installed");
      const archiveRoot = path.join(installedRoot, "dist/worker-artifacts");
      await fs.mkdir(archiveRoot, { recursive: true });
      const packagedArchive = path.join(archiveRoot, `${built.bundleHash}.tar.gz`);
      await fs.copyFile(built.tarballPath, packagedArchive);
      const installedAlias = path.join(root, "installed-alias");
      await fs.symlink(installedRoot, installedAlias, "junction");
      const throughAlias = await producer(installedAlias, path.join(root, "alias-cache")).prepare();
      expect(throughAlias).toMatchObject({
        bundleHash: built.bundleHash,
        tarballSha256: built.tarballSha256,
        tarballPath: path.join(
          installedAlias,
          "dist/worker-artifacts",
          `${built.bundleHash}.tar.gz`,
        ),
      });
      await expectMissing(path.join(root, "alias-cache"));
    });
  });

  it("hashes and archives only the dedicated deploy artifacts", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-" }, async (root) => {
      const packageA = path.join(root, "package-a");
      const packageB = path.join(root, "package-b");
      await writeFixture(packageA, "export const worker = true;\n", 48);
      await writeFixture(packageB, "export const worker = true;\n", 48);
      await fs.mkdir(path.join(packageA, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(packageA, "dist", "entry.js"), 'import "json5";\n');
      await fs.writeFile(
        path.join(packageA, "dist", "control-ui", "index.html"),
        "<main>UI</main>",
      );
      await fs.utimes(
        path.join(packageA, "dist", "worker", "worker.mjs"),
        new Date(1_000),
        new Date(1_000),
      );
      await fs.utimes(
        path.join(packageB, "dist", "worker", "worker.mjs"),
        new Date(9_000),
        new Date(9_000),
      );

      const first = await producer(packageA, path.join(root, "cache-a"), {
        openclawVersion: "1.2.3",
      }).prepare();
      const second = await producer(packageB, path.join(root, "cache-b"), {
        openclawVersion: "1.2.3",
      }).prepare();
      expect(second.bundleHash).toBe(first.bundleHash);
      expect(second.tarballSha256).toBe(first.tarballSha256);
      const entries = await listTarball(first.tarballPath);
      expect(entries).toEqual(expect.arrayContaining(Object.keys(ARTIFACTS)));
      expect(entries).toHaveLength(Object.keys(ARTIFACTS).length + 48);
      const installPrefix = `.openclaw-worker/${first.bundleHash}/`;
      const receiverPath = workerWorkspaceRsyncReceiverEntryPath(first.bundleHash);
      expect(receiverPath.startsWith(installPrefix)).toBe(true);
      expect(entries).toContain(receiverPath.slice(installPrefix.length));
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot);
      await tar.extract({ file: first.tarballPath, cwd: extractRoot });
      expect(await readText(extractRoot, "worker-chunk-0.mjs")).toBe("export const value = 0;\n");
      for (const [artifactName, expectedContents] of Object.entries(ARTIFACTS).filter(
        ([name]) => !["code-mode-node.worker.mjs", "windows-security-helper.exe"].includes(name),
      )) {
        await expect(fs.readFile(path.join(extractRoot, artifactName), "utf8")).resolves.toBe(
          expectedContents,
        );
        if (process.platform !== "win32") {
          expect((await fs.stat(path.join(extractRoot, artifactName))).mode & 0o777).toBe(0o700);
        }
      }
      await expect(fs.access(path.join(extractRoot, "package.json"))).rejects.toThrow();
      await expect(fs.access(path.join(extractRoot, "node_modules"))).rejects.toThrow();
      await fs.writeFile(path.join(packageA, "dist/entry.js"), "unrelated change");
      expect((await producer(packageA, path.join(root, "cache-a")).prepare()).bundleHash).toBe(
        first.bundleHash,
      );
      let previousHash = first.bundleHash;
      for (const name of ["worker.mjs", "worker-chunk-0.mjs"]) {
        await fs.writeFile(artifactPath(packageA, name), "changed");
        const changed = await producer(packageA, path.join(root, "cache-a")).prepare();
        expect(changed.bundleHash).not.toBe(previousHash);
        previousHash = changed.bundleHash;
      }
    });
  });

  it("packages hardlinked artifacts larger than the default file-read limit", async () => {
    await withBundleFixture(async ({ root, packageRoot, cacheDir }) => {
      const padding = "x".repeat(128);
      const contents = Array.from(
        { length: 128 * 1024 },
        (_, index) => `//${index}:${padding}\n`,
      ).join("");
      await writeFixture(packageRoot, contents);
      await fs.link(artifactPath(packageRoot), path.join(root, "source-alias.mjs"));

      const artifact = await producer(packageRoot, cacheDir).prepare();
      const extractDir = path.join(root, "extract");
      await fs.mkdir(extractDir);
      await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

      await expect(readText(extractDir, "worker.mjs")).resolves.toBe(contents);
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(extractDir, "worker.mjs"))).mode & 0o777).toBe(0o700);
      }
    });
  });

  it("skips retention reads when the cache has no cleanup candidates", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot);
      const owner = producer(packageRoot, cacheDir);
      const current = await owner.prepare();
      for (const name of ["keep-me.txt", "not-a-hash.tgz", ".staging"]) {
        await fs.writeFile(path.join(cacheDir, name), "operator-owned");
      }
      const before = (await fs.readdir(cacheDir)).toSorted();
      const readRetained = vi.fn(() => []);

      await owner.prune(readRetained);

      expect(readRetained).not.toHaveBeenCalled();
      expect((await fs.readdir(cacheDir)).toSorted()).toEqual(before);
      await expectPresent(current.tarballPath);
    });
  });

  it.each([false, true])(
    "retains a persisted provisioning bundle until its environment terminates (empty=%s)",
    async (empty) => {
      await withBundleFixture(async ({ root, packageRoot, cacheDir }) => {
        const databasePath = path.join(root, "state", "openclaw.sqlite");
        await writeFixture(packageRoot, "export const value = 1;\n");
        const admitted = await producer(packageRoot, cacheDir).prepare();
        const admittedBytes = await fs.readFile(admitted.tarballPath);
        const project = { key: "project", root, baseCommit: "a".repeat(40) };
        const preparation = createWorkerPreparationIdentity({
          namespace: "bundle-retention-test",
          providerId: "fixture",
          profileId: "test",
          profileSnapshot: { settings: {} },
          project: empty ? undefined : project,
          target: { machineClass: "small", platform: "linux" },
          artifacts: {
            nodeBootstrapSha256: "b".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: admitted.bundleHash,
            workerArchiveSha256: admitted.tarballSha256,
            openclawVersion: admitted.openclawVersion,
            protocolFeatures: [...admitted.protocolFeatures],
          },
        });
        try {
          const store = await createWorkerEnvironmentStore({
            database: openOpenClawStateDatabase({ path: databasePath }),
          });
          await store.createIntent({
            environmentId: "preparing",
            providerId: "fixture",
            profileId: "test",
            provisionOperationId: "prepare-project",
            profileSnapshot: {
              settings: {},
              ...(empty
                ? { runtimePreparation: { source: "empty", ...preparation } }
                : { project: { ...project, preparation } }),
            },
          });
          await store.transition({
            environmentId: "preparing",
            from: "requested",
            to: "provisioning",
          });
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();

          await writeFixture(packageRoot, "export const value = 2;\n");
          const successor = producer(packageRoot, cacheDir);
          const current = await successor.prepare();
          expect(current.bundleHash).not.toBe(admitted.bundleHash);
          const reopened = await createWorkerEnvironmentStore({
            database: openOpenClawStateDatabase({ path: databasePath }),
          });
          expect(reopened.get("preparing")).toMatchObject({
            state: "provisioning",
            bootstrapReceipt: null,
          });
          const retained = () =>
            listRetainedWorkerBundleHashes({ environments: reopened.list(), placements: [] });

          await successor.prune(retained);
          await expect(fs.readFile(admitted.tarballPath)).resolves.toEqual(admittedBytes);

          await reopened.transition({
            environmentId: "preparing",
            from: "provisioning",
            to: "failed",
          });
          await successor.prune(retained);
          await expectMissing(admitted.tarballPath);
          await expectPresent(current.tarballPath);
        } finally {
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
  );

  it("preserves every cleanup candidate when retention cannot be read", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot);
      const owner = producer(packageRoot, cacheDir);
      const current = await owner.prepare();
      const unknown = path.join(cacheDir, "keep-me.txt");
      await fs.writeFile(unknown, "operator-owned");
      const historical = path.join(cacheDir, `${"b".repeat(64)}.tgz`);
      const staging = path.join(cacheDir, ".staging-stale");
      const temporary = path.join(
        cacheDir,
        `${current.bundleHash}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
      );
      const candidates = [historical, staging, temporary];
      await fs.writeFile(historical, "historical");
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, "partial"), "staged");
      await fs.writeFile(temporary, "partial");
      const failure = new Error("Retention records are unavailable");

      await expect(
        owner.prune(() => {
          throw failure;
        }),
      ).rejects.toBe(failure);

      for (const candidate of candidates) {
        const file = candidate === staging ? path.join(staging, "partial") : candidate;
        const contents =
          candidate === historical ? "historical" : candidate === staging ? "staged" : "partial";
        await expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
      }
      await expectPresent(current.tarballPath);

      await owner.prune(() => []);
      for (const removed of candidates) {
        await expectMissing(removed);
      }
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("operator-owned");
      await expectPresent(current.tarballPath);
    });
  });

  it("reads retention when queued pruning runs", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot);
      const owner = producer(packageRoot, cacheDir);
      const current = await owner.prepare();
      const firstHash = "a".repeat(64);
      const secondHash = "b".repeat(64);
      const obsolete = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      for (const hash of [firstHash, secondHash]) {
        await fs.writeFile(path.join(cacheDir, `${hash}.tgz`), hash);
      }
      await fs.writeFile(obsolete, "obsolete");
      const inspectingObsolete = createDeferred();
      const releaseInspection = createDeferred();
      const originalLstat = fs.lstat;
      const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
        if (target === obsolete) {
          inspectingObsolete.resolve();
          await releaseInspection.promise;
        }
        return originalLstat(target, options);
      });
      const first = owner.prune(() => [firstHash, secondHash]);
      let second: Promise<void> | undefined;
      let retained = [firstHash];
      const readRetained = vi.fn(() => retained);
      try {
        await inspectingObsolete.promise;
        second = owner.prune(readRetained);
        expect(readRetained).not.toHaveBeenCalled();
        retained = [firstHash, secondHash];
        releaseInspection.resolve();
        await Promise.all([first, second]);

        expect(readRetained).toHaveBeenCalledTimes(1);
        for (const hash of [firstHash, secondHash]) {
          await expect(fs.readFile(path.join(cacheDir, `${hash}.tgz`), "utf8")).resolves.toBe(hash);
        }
        await expectMissing(obsolete);
        await expectPresent(current.tarballPath);
      } finally {
        releaseInspection.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        lstat.mockRestore();
      }
    });
  });

  it("keeps custom caches non-destructive after failed preparation", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-shared-cache-" }, async (root) => {
      const cacheDir = path.join(root, "cache");
      await fs.mkdir(cacheDir);
      const historical = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(historical, "historical");
      const shared = createWorkerBundleProducer({
        packageRoot: path.join(root, "missing-package"),
        cacheDir,
      });

      await expect(shared.prepare()).rejects.toThrow("worker deploy artifact is missing");
      await shared.prune(() => []);
      await expect(fs.readFile(historical, "utf8")).resolves.toBe("historical");
    });
  });

  it("archives staged bytes when the source changes during packaging", async () => {
    await withBundleFixture(async ({ root, packageRoot, cacheDir }) => {
      const baselineRoot = path.join(root, "baseline");
      const originalContents = "export const value = 'before';\n";
      const changedContents = "export const value = 'after';\n";
      await writeFixture(baselineRoot, originalContents);
      await writeFixture(packageRoot, originalContents);
      const baseline = await producer(baselineRoot, path.join(root, "baseline-cache")).prepare();
      const originalWriteFile = fs.writeFile;
      let sourceMutated = false;
      const stagingWrite = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await originalWriteFile(...args);
        const [target] = args;
        if (
          typeof target === "string" &&
          path.basename(target) === "worker.mjs" &&
          path.dirname(target).startsWith(`${cacheDir}${path.sep}.staging-`)
        ) {
          sourceMutated = true;
          await originalWriteFile(artifactPath(packageRoot), changedContents);
        }
      });

      try {
        const artifact = await producer(packageRoot, cacheDir).prepare();
        const extractDir = path.join(root, "extract");
        await fs.mkdir(extractDir);
        await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

        expect(sourceMutated).toBe(true);
        expect(artifact.bundleHash).toBe(baseline.bundleHash);
        await expect(readText(extractDir, "worker.mjs")).resolves.toBe(originalContents);
      } finally {
        stagingWrite.mockRestore();
      }
    });
  });

  it("owns one immutable build snapshot and retries failed preparation", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      const owner = producer(packageRoot, cacheDir, {
        protocolFeatures: ["resume", "admission", "resume"],
      });
      const failed = owner.prepare();
      await expect(failed).rejects.toThrow("worker deploy artifact is missing");
      await writeFixture(packageRoot);

      const retried = owner.prepare();
      expect(retried).not.toBe(failed);
      const first = await retried;
      await fs.writeFile(artifactPath(packageRoot), "changed\n");
      await expect(owner.prepare()).resolves.toBe(first);
      expect(first.protocolFeatures).toEqual(["admission", "resume"]);
    });
  });

  it("replaces a corrupt content-addressed cache entry", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot);
      const first = await producer(packageRoot, cacheDir).prepare();
      await fs.writeFile(first.tarballPath, "not a tarball");

      const repaired = await producer(packageRoot, cacheDir).prepare();

      expect(repaired.bundleHash).toBe(first.bundleHash);
      await expect(listTarball(repaired.tarballPath)).resolves.toEqual(Object.keys(ARTIFACTS));
    });
  });

  it.skipIf(process.platform === "win32")("rejects symlinked deploy artifacts", async () => {
    for (const artifactName of ["worker.mjs", "worker-chunk-symlink.mjs"]) {
      await withBundleFixture(async ({ packageRoot, cacheDir }) => {
        await writeFixture(packageRoot);
        const artifact = artifactPath(packageRoot, artifactName);
        if (artifactName === "worker-chunk-symlink.mjs") {
          await fs.writeFile(artifact, "export {};\n");
        }
        await fs.rename(artifact, `${artifact}.target`);
        await fs.symlink(`${artifactName}.target`, artifact);

        await expect(producer(packageRoot, cacheDir).prepare()).rejects.toThrow(
          "Unsafe worker deploy artifact",
        );
        // Sibling artifacts stage concurrently; their writes must settle before staging cleanup.
        await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
      });
    }
  });
});

describe("worker npm installation artifact", () => {
  it("uses an exact registry-proven gateway package", async () => {
    await withTestDir({ prefix: "openclaw-worker-npm-release-" }, async (packageRoot) => {
      await writeFixture(packageRoot);
      const packageIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      const verifyRelease = vi.fn(async () => packageIntegrity);

      const artifact = await resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact({ protocolFeatures: ["admission"] }),
        packageRoot,
        verifyRelease,
      });

      expect(verifyRelease).toHaveBeenCalledWith({
        bundleHash: "a".repeat(64),
        version: "1.2.3",
      });
      expect(artifact).toEqual({
        install: "npm",
        bundleHash: "a".repeat(64),
        openclawVersion: "1.2.3",
        packageIntegrity,
        protocolFeatures: ["admission"],
        packageSpec: "openclaw@1.2.3",
      });
    });
  });

  it("rejects dev and packages that fail release verification", async () => {
    const verifyRelease = vi.fn(async (): Promise<string> => {
      throw new Error("OpenClaw 1.2.3 is not published; use the worker bundle install");
    });
    await expect(
      resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact({ openclawVersion: "dev" }),
        verifyRelease,
      }),
    ).rejects.toThrow("exact published gateway version");
    expect(verifyRelease).not.toHaveBeenCalled();
    await withTestDir({ prefix: "openclaw-worker-npm-unpublished-" }, async (packageRoot) => {
      await expect(
        resolveWorkerNpmInstallationArtifact({
          bundle: bundleArtifact(),
          packageRoot,
          verifyRelease,
        }),
      ).rejects.toThrow("use the worker bundle install");
    });
  });

  it("rejects a source checkout even when its version is published", async () => {
    await withTestDir({ prefix: "openclaw-worker-npm-source-" }, async (packageRoot) => {
      await writeFixture(packageRoot);
      await fs.mkdir(path.join(packageRoot, ".git"));
      const verifyRelease = vi.fn(async () => `sha512-${Buffer.alloc(64).toString("base64")}`);

      await expect(
        resolveWorkerNpmInstallationArtifact({
          bundle: bundleArtifact(),
          packageRoot,
          verifyRelease,
        }),
      ).rejects.toThrow("packaged release install");
      expect(verifyRelease).not.toHaveBeenCalled();
    });
  });
});
