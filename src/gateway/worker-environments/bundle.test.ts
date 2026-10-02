import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as bundleStaging from "./bundle-staging.js";
import {
  createWorkerBundleProducer,
  resolveWorkerNpmInstallationArtifact,
  type WorkerInstallationArtifact,
} from "./bundle.js";
import { createWorkerProjectPreparationIdentity } from "./preparation-identity.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";
import { workerWorkspaceRsyncReceiverEntryPath } from "./workspace-sync-helpers.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

async function writeFixture(
  packageRoot: string,
  workerSource = "export const worker = true;\n",
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
  for (const [artifactName, contents] of [
    ["file-tool-planning.worker.mjs", "export const fileToolPlanning = true;\n"],
    ["github-exec-launcher.mjs", "export const launcher = true;\n"],
    ["image-processor.worker.mjs", "export const imageProcessor = true;\n"],
    ["service-child-group-anchor.mjs", "export const anchor = true;\n"],
    ["service-child-relay.mjs", "export const relay = true;\n"],
    ["sqlite-store.worker.mjs", "export const sqliteStore = true;\n"],
    ["worker.mjs", workerSource],
    ["workspace-rsync-receiver.mjs", "export const receiver = true;\n"],
  ] as const) {
    await fs.writeFile(path.join(packageRoot, "dist", "worker", artifactName), contents, {
      encoding: "utf8",
      mode: 0o755,
    });
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

      const first = await createWorkerBundleProducer({
        packageRoot: packageA,
        cacheDir: path.join(root, "cache-a"),
        openclawVersion: "1.2.3",
      }).prepare();
      const second = await createWorkerBundleProducer({
        packageRoot: packageB,
        cacheDir: path.join(root, "cache-b"),
        openclawVersion: "1.2.3",
      }).prepare();
      expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.bundleHash).toBe(first.bundleHash);
      const compressed = await fs.readFile(first.tarballPath);
      expect(first.tarballSha256).toBe(createHash("sha256").update(compressed).digest("hex"));
      expect(first.tarballBytes).toBe(compressed.byteLength);
      const entries = await listTarball(first.tarballPath);
      expect(entries).toEqual([
        "file-tool-planning.worker.mjs",
        "github-exec-launcher.mjs",
        "image-processor.worker.mjs",
        "service-child-group-anchor.mjs",
        "service-child-relay.mjs",
        "sqlite-store.worker.mjs",
        "worker.mjs",
        "workspace-rsync-receiver.mjs",
      ]);
      const installPrefix = `.openclaw-worker/${first.bundleHash}/`;
      const receiverPath = workerWorkspaceRsyncReceiverEntryPath(first.bundleHash);
      expect(receiverPath.startsWith(installPrefix)).toBe(true);
      expect(entries).toContain(receiverPath.slice(installPrefix.length));
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot);
      await tar.extract({ file: first.tarballPath, cwd: extractRoot });
      for (const [artifactName, expectedContents] of [
        ["file-tool-planning.worker.mjs", "export const fileToolPlanning = true;\n"],
        ["github-exec-launcher.mjs", "export const launcher = true;\n"],
        ["image-processor.worker.mjs", "export const imageProcessor = true;\n"],
        ["service-child-group-anchor.mjs", "export const anchor = true;\n"],
        ["service-child-relay.mjs", "export const relay = true;\n"],
        ["sqlite-store.worker.mjs", "export const sqliteStore = true;\n"],
        ["worker.mjs", "export const worker = true;\n"],
        ["workspace-rsync-receiver.mjs", "export const receiver = true;\n"],
      ] as const) {
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
    await withTestDir({ prefix: "openclaw-worker-bundle-change-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, "export const value = 1;\n");
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      await fs.writeFile(
        path.join(packageRoot, "dist", "entry.js"),
        "export const unrelated = 2;\n",
      );
      const unrelated = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      expect(unrelated.bundleHash).toBe(first.bundleHash);

      let previousHash = first.bundleHash;
      for (const artifactName of [
        "file-tool-planning.worker.mjs",
        "github-exec-launcher.mjs",
        "image-processor.worker.mjs",
        "service-child-group-anchor.mjs",
        "service-child-relay.mjs",
        "sqlite-store.worker.mjs",
        "worker.mjs",
        "workspace-rsync-receiver.mjs",
      ]) {
        await fs.writeFile(
          path.join(packageRoot, "dist", "worker", artifactName),
          "export const changed = true;\n",
        );
        const changed = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
        expect(changed.bundleHash, artifactName).not.toBe(previousHash);
        previousHash = changed.bundleHash;
      }
    });
  });

  it("packages hardlinked artifacts larger than the default file-read limit", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-large-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const padding = "x".repeat(128);
      const contents = Array.from(
        { length: 128 * 1024 },
        (_, index) => `//${index}:${padding}\n`,
      ).join("");
      await writeFixture(packageRoot, contents);
      await fs.link(
        path.join(packageRoot, "dist", "worker", "worker.mjs"),
        path.join(root, "source-alias.mjs"),
      );

      const artifact = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      }).prepare();
      const extractDir = path.join(root, "extract");
      await fs.mkdir(extractDir);
      await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

      await expect(fs.readFile(path.join(extractDir, "worker.mjs"), "utf8")).resolves.toBe(
        contents,
      );
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(extractDir, "worker.mjs"))).mode & 0o777).toBe(0o700);
      }
    });
  });

  it("skips retention reads when the cache has no cleanup candidates", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-noop-prune-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
      const current = await owner.prepare();
      for (const name of ["keep-me.txt", "not-a-hash.tgz", ".staging"]) {
        await fs.writeFile(path.join(cacheDir, name), "operator-owned");
      }
      const before = (await fs.readdir(cacheDir)).toSorted();
      const readRetained = vi.fn(() => []);

      await owner.prune(readRetained);

      expect(readRetained).not.toHaveBeenCalled();
      expect((await fs.readdir(cacheDir)).toSorted()).toEqual(before);
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
    });
  });

  it("prunes only unretained bundles for an exclusive cache owner", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-prune-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, "export const value = 1;\n");
      const retained = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      await fs.writeFile(
        path.join(packageRoot, "dist", "worker", "worker.mjs"),
        "export const value = 2;\n",
      );
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
      const current = await owner.prepare();
      const removedPath = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(removedPath, "historical");

      await owner.prune(() => [retained.bundleHash]);

      await expect(fs.stat(retained.tarballPath)).resolves.toBeDefined();
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      await expect(fs.stat(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retains a persisted provisioning bundle until its environment terminates", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-provisioning-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      await writeFixture(packageRoot, "export const value = 1;\n");
      const admitted = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      const admittedBytes = await fs.readFile(admitted.tarballPath);
      const project = { key: "project", root, baseCommit: "a".repeat(40) };
      const preparation = createWorkerProjectPreparationIdentity({
        namespace: "bundle-retention-test",
        providerId: "fixture",
        profileId: "test",
        profileSnapshot: { settings: {} },
        project,
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
          profileSnapshot: { settings: {}, project: { ...project, preparation } },
        });
        await store.transition({
          environmentId: "preparing",
          from: "requested",
          to: "provisioning",
        });
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();

        await writeFixture(packageRoot, "export const value = 2;\n");
        const successor = createWorkerBundleProducer({
          packageRoot,
          cacheDir,
          cacheOwnership: "exclusive",
        });
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
        await expect(fs.stat(admitted.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      } finally {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    });
  });

  it("reclaims recognized crash artifacts but preserves unknown cache entries", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-crash-cleanup-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
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

      await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("operator-owned");
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
    });
  });

  it.each(["all", "staging", "temporary"] as const)(
    "preserves cleanup candidates when retention cannot be read (%s)",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-worker-bundle-retention-error-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const cacheDir = path.join(root, "cache");
        await writeFixture(packageRoot);
        const owner = createWorkerBundleProducer({
          packageRoot,
          cacheDir,
          cacheOwnership: "exclusive",
        });
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
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();

        await owner.prune(() => []);
        for (const removed of candidates) {
          await expect(fs.stat(removed)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      });
    },
  );

  it("reads retention when queued pruning runs", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-queued-prune-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
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
        await expect(fs.stat(obsolete)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
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
    await withTestDir({ prefix: "openclaw-worker-bundle-mutation-" }, async (root) => {
      const baselineRoot = path.join(root, "baseline");
      const packageRoot = path.join(root, "package");
      const originalContents = "export const value = 'before';\n";
      const changedContents = "export const value = 'after';\n";
      await writeFixture(baselineRoot, originalContents);
      await writeFixture(packageRoot, originalContents);
      const baseline = await createWorkerBundleProducer({
        packageRoot: baselineRoot,
        cacheDir: path.join(root, "baseline-cache"),
      }).prepare();
      const originalCollect = bundleStaging.collectWorkerBundleManifest;
      let sourceMutated = false;
      const stagingSpy = vi
        .spyOn(bundleStaging, "collectWorkerBundleManifest")
        .mockImplementation(async (...args) => {
          const manifest = await originalCollect(...args);
          sourceMutated = true;
          await fs.writeFile(
            path.join(packageRoot, "dist", "worker", "worker.mjs"),
            changedContents,
          );
          return manifest;
        });

      try {
        const artifact = await createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
        }).prepare();
        const extractDir = path.join(root, "extract");
        await fs.mkdir(extractDir);
        await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

        expect(sourceMutated).toBe(true);
        expect(artifact.bundleHash).toBe(baseline.bundleHash);
        await expect(fs.readFile(path.join(extractDir, "worker.mjs"), "utf8")).resolves.toBe(
          originalContents,
        );
      } finally {
        stagingSpy.mockRestore();
      }
    });
  });

  it("owns one immutable build snapshot and retries failed preparation", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-cache-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const producer = createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
        protocolFeatures: ["resume", "admission", "resume"],
      });
      const failed = producer.prepare();
      await expect(failed).rejects.toThrow("worker deploy artifact is missing");
      await writeFixture(packageRoot);

      const retried = producer.prepare();
      expect(retried).not.toBe(failed);
      const first = await retried;
      await fs.writeFile(path.join(packageRoot, "dist", "worker", "worker.mjs"), "changed\n");
      await expect(producer.prepare()).resolves.toBe(first);
      expect(first.protocolFeatures).toEqual(["admission", "resume"]);
    });
  });

  it("replaces a corrupt content-addressed cache entry", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-corrupt-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      await fs.writeFile(first.tarballPath, "not a tarball");

      const repaired = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      expect(repaired.bundleHash).toBe(first.bundleHash);
      await expect(listTarball(repaired.tarballPath)).resolves.toEqual([
        "file-tool-planning.worker.mjs",
        "github-exec-launcher.mjs",
        "image-processor.worker.mjs",
        "service-child-group-anchor.mjs",
        "service-child-relay.mjs",
        "sqlite-store.worker.mjs",
        "worker.mjs",
        "workspace-rsync-receiver.mjs",
      ]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects symlinked deploy artifacts", async () => {
    for (const artifactName of [
      "file-tool-planning.worker.mjs",
      "github-exec-launcher.mjs",
      "image-processor.worker.mjs",
      "service-child-group-anchor.mjs",
      "service-child-relay.mjs",
      "sqlite-store.worker.mjs",
      "worker.mjs",
      "workspace-rsync-receiver.mjs",
    ]) {
      await withTestDir({ prefix: "openclaw-worker-bundle-symlink-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        await writeFixture(packageRoot);
        const artifactPath = path.join(packageRoot, "dist", "worker", artifactName);
        await fs.rename(artifactPath, `${artifactPath}.target`);
        await fs.symlink(`${artifactName}.target`, artifactPath);

        await expect(
          createWorkerBundleProducer({
            packageRoot,
            cacheDir: path.join(root, "cache"),
          }).prepare(),
        ).rejects.toThrow("Unsafe worker deploy artifact");
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
        isPackageInstall: async () => true,
        verifyRelease,
      }),
    ).rejects.toThrow("exact published gateway version");
    expect(verifyRelease).not.toHaveBeenCalled();
    await expect(
      resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact(),
        isPackageInstall: async () => true,
        verifyRelease,
      }),
    ).rejects.toThrow("use the worker bundle install");
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
