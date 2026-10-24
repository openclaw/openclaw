import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  extractWorkerBundleArchive,
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
} from "../../shared/worker-bundle-archive.js";
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
  "client-credential.worker.mjs": "export const clientCredentials = true;\n",
  "code-mode-node.worker.mjs": "export const codeModeNode = true;\n",
  "file-tool-planning.worker.mjs": "export const fileToolPlanning = true;\n",
  "file-tool-read.worker.mjs": "export const fileToolRead = true;\n",
  "fs-safe-darwin-arm64.node": "arm64-native-fixture",
  "fs-safe-darwin-x64.node": "x64-native-fixture",
  "gateway-state-owner-heartbeat.worker.mjs": "export const heartbeat = true;\n",
  "github-exec-launcher.mjs": "export const launcher = true;\n",
  "image-processor.worker.mjs": "export const imageProcessor = true;\n",
  "openclaw-state-read.worker.mjs": "export const stateRead = true;\n",
  "service-child-group-anchor.mjs": "export const anchor = true;\n",
  "service-child-relay.mjs": "export const relay = true;\n",
  "sqlite-source-revision.worker.mjs": "export const sqliteSourceRevision = true;\n",
  "sqlite-store.worker.mjs": "export const sqliteStore = true;\n",
  "windows-security-helper.exe": "MZ\0worker-permission-helper",
  "worker-native-lifecycle.worker.mjs": "export const nativeLifecycle = true;\n",
  "worker.mjs": "export const worker = true;\n",
  "workspace-rsync-receiver.mjs": "export const receiver = true;\n",
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
  it("stages many chunks deterministically", async () => {
    await withBundleFixture(async ({ root, packageRoot, cacheDir }) => {
      await writeFixture(packageRoot, 'export { value } from "./worker-chunk-0.mjs";', 48);
      const chunk = path.join(packageRoot, "dist/worker/worker-chunk-0.mjs");
      const first = await producer(packageRoot, cacheDir).prepare();
      const second = await producer(packageRoot, path.join(root, "second-cache")).prepare();
      expect(second.bundleHash).toBe(first.bundleHash);
      expect(second.tarballSha256).toBe(first.tarballSha256);
      expect(await listTarball(first.tarballPath)).toContain("worker-chunk-0.mjs");
      const destination = path.join(root, "installed");
      await extractWorkerBundleArchive({
        tarballPath: first.tarballPath,
        destination,
        expectedBundleHash: first.bundleHash,
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      });
      expect(await readText(destination, "worker-chunk-0.mjs")).toBe("export const value = 0;\n");
      await fs.writeFile(chunk, "export const value = 2;");
      const changed = await producer(packageRoot, cacheDir).prepare();
      expect(changed.bundleHash).not.toBe(first.bundleHash);
    });
  });

  it("reuses the sealed worker graph from an installed npm package", async () => {
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
      await fs.writeFile(
        path.join(installedRoot, "package.json"),
        `${JSON.stringify({ name: "openclaw", version: "1.2.3" })}\n`,
      );
      const packagedArchive = path.join(archiveRoot, `${built.bundleHash}.tar.gz`);
      await fs.copyFile(built.tarballPath, packagedArchive);

      const installed = await producer(installedRoot, path.join(root, "installed-cache")).prepare();
      expect(installed).toMatchObject({
        bundleHash: built.bundleHash,
        tarballPath: packagedArchive,
      });
      expect(installed.tarballSha256).toBe(built.tarballSha256);
      await expect(fs.stat(path.join(root, "installed-cache"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const installedAlias = path.join(root, "installed-alias");
      await fs.symlink(installedRoot, installedAlias, "junction");
      const throughAlias = await producer(installedAlias, path.join(root, "alias-cache")).prepare();
      expect(throughAlias).toMatchObject({
        bundleHash: built.bundleHash,
        tarballPath: path.join(
          installedAlias,
          "dist/worker-artifacts",
          `${built.bundleHash}.tar.gz`,
        ),
      });
    });
  });

  it("hashes and archives only the dedicated deploy artifacts", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-" }, async (root) => {
      const packageA = path.join(root, "package-a");
      const packageB = path.join(root, "package-b");
      await writeFixture(packageA);
      await writeFixture(packageB);
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
      expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.bundleHash).toBe(first.bundleHash);
      const compressed = await fs.readFile(first.tarballPath);
      expect(first.tarballSha256).toBe(createHash("sha256").update(compressed).digest("hex"));
      expect(first.tarballBytes).toBe(compressed.byteLength);
      const entries = await listTarball(first.tarballPath);
      expect(entries).toEqual(Object.keys(ARTIFACTS));
      const installPrefix = `.openclaw-worker/${first.bundleHash}/`;
      const receiverPath = workerWorkspaceRsyncReceiverEntryPath(first.bundleHash);
      expect(receiverPath.startsWith(installPrefix)).toBe(true);
      expect(entries).toContain(receiverPath.slice(installPrefix.length));
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot);
      await tar.extract({ file: first.tarballPath, cwd: extractRoot });
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
    });
  });

  it("changes identity only when the deploy artifact changes", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot, "export const value = 1;\n");
      const first = await producer(packageRoot, cacheDir).prepare();

      await fs.writeFile(
        path.join(packageRoot, "dist", "entry.js"),
        "export const unrelated = 2;\n",
      );
      const unrelated = await producer(packageRoot, cacheDir).prepare();
      expect(unrelated.bundleHash).toBe(first.bundleHash);

      let previousHash = first.bundleHash;
      for (const artifactName of Object.keys(ARTIFACTS).filter(
        (name) => name !== "code-mode-node.worker.mjs",
      )) {
        await fs.writeFile(
          artifactPath(packageRoot, artifactName),
          "export const changed = true;\n",
        );
        const changed = await producer(packageRoot, cacheDir).prepare();
        expect(changed.bundleHash, artifactName).not.toBe(previousHash);
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

  it("prunes only unretained bundles for an exclusive cache owner", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot, "export const value = 1;\n");
      const retained = await producer(packageRoot, cacheDir).prepare();
      await fs.writeFile(artifactPath(packageRoot), "export const value = 2;\n");
      const owner = producer(packageRoot, cacheDir);
      const current = await owner.prepare();
      const removedPath = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(removedPath, "historical");

      await owner.prune(() => [retained.bundleHash]);

      await expectPresent(retained.tarballPath);
      await expectPresent(current.tarballPath);
      await expectMissing(removedPath);
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

  it("reclaims recognized crash artifacts but preserves unknown cache entries", async () => {
    await withBundleFixture(async ({ packageRoot, cacheDir }) => {
      await writeFixture(packageRoot);
      const owner = producer(packageRoot, cacheDir);
      const current = await owner.prepare();
      const staging = path.join(cacheDir, ".staging-stale");
      const temporary = path.join(
        cacheDir,
        `${"b".repeat(64)}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
      );
      const unknown = path.join(cacheDir, "keep-me.txt");
      await fs.mkdir(staging);
      await fs.writeFile(temporary, "partial");
      await fs.writeFile(unknown, "operator-owned");

      await owner.prune(() => []);

      await expectMissing(staging);
      await expectMissing(temporary);
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("operator-owned");
      await expectPresent(current.tarballPath);
    });
  });

  it.each(["all", "staging", "temporary"] as const)(
    "preserves cleanup candidates when retention cannot be read (%s)",
    async (kind) => {
      await withBundleFixture(async ({ packageRoot, cacheDir }) => {
        await writeFixture(packageRoot);
        const owner = producer(packageRoot, cacheDir);
        const current = await owner.prepare();
        const historical = path.join(cacheDir, `${"b".repeat(64)}.tgz`);
        const staging = path.join(cacheDir, ".staging-stale");
        const temporary = path.join(
          cacheDir,
          `${current.bundleHash}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
        );
        const candidates =
          kind === "all"
            ? [historical, staging, temporary]
            : [kind === "staging" ? staging : temporary];
        if (candidates.includes(historical)) {
          await fs.writeFile(historical, "historical");
        }
        if (candidates.includes(staging)) {
          await fs.mkdir(staging);
          await fs.writeFile(path.join(staging, "partial"), "staged");
        }
        if (candidates.includes(temporary)) {
          await fs.writeFile(temporary, "partial");
        }
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
        await expectPresent(current.tarballPath);
      });
    },
  );

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
    for (const artifactName of [
      "worker-chunk-symlink.mjs",
      ...Object.keys(ARTIFACTS).filter(
        (name) =>
          ![
            "code-mode-node.worker.mjs",
            "fs-safe-darwin-arm64.node",
            "fs-safe-darwin-x64.node",
            "windows-security-helper.exe",
          ].includes(name),
      ),
    ]) {
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
