import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { indexStoreFixture } from "./installed-plugin-index-family.test-support.js";
import { refreshPersistedInstalledPluginIndexWithReceipt } from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  resetPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import * as worker from "./plugin-generation-worker.js";
import { PluginInventoryRetiredError } from "./plugin-instance-error.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import { prepareInstalledPluginGenerationArtifact } from "./plugin-source-snapshot-runtime.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";
import { createInstalledPluginIndexCandidate } from "./test-helpers/installed-plugin-index.js";

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDefaultRetainedNativeWorkerSource();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withFixture(
  digest: boolean,
  run: (fixture: {
    rootDir: string;
    entry: string;
    record: PluginInstallRecord;
    warnings: Array<{ message: string; source: string }>;
    read: () => ReturnType<typeof parseInstalledPluginIndex>;
    writeSnapshot: (descriptor: PluginSourceSnapshotDescriptor) => Promise<void>;
    refresh: (record: PluginInstallRecord) => Promise<unknown>;
    prepare: () => ReturnType<typeof prepareInstalledPluginGenerationArtifact>;
    selectInventory: () => void;
    inventoryRetired: () => boolean;
  }) => Promise<void>,
) {
  const stateDir = fs.realpathSync(temp.make("plugin-snapshot-runtime-"));
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const rootDir = path.join(stateDir, "installed");
  fs.mkdirSync(rootDir);
  const candidate = recordPluginCandidateInstallOwner(
    createInstalledPluginIndexCandidate(rootDir),
    "package-owner",
  );
  const entry = candidate.source;
  const source = "export const value = 'installed';\n";
  fs.writeFileSync(entry, source);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      type: "module",
      dependencies: { dep: "1.0.0" },
    }),
  );
  const dependency = path.join(rootDir, "node_modules", "dep");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"dep","main":"index.js"}');
  fs.writeFileSync(path.join(dependency, "index.js"), "module.exports = 'dependency';\n");
  const store = indexStoreFixture(stateDir, env);
  const cache = createPluginCache();
  await withPluginInstallRoots(resolvePluginInstallRoots(env), () =>
    withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
      withPluginCache(cache, async () => {
        const owned = new Map<string, PluginSourceSnapshotDescriptor>();
        try {
          const record: PluginInstallRecord = {
            source: "npm",
            spec: "demo@1.0.0",
            installPath: rootDir,
          };
          if (digest) {
            const capture = await worker.preparePluginSourceSnapshot({ stateDir, rootDir });
            try {
              record.sourceSnapshotDigests = {
                demo: {
                  contentDigest: capture.contentDigest,
                  dependencyClosureDigest: capture.dependencyClosureDigest,
                },
              };
            } finally {
              await capture.disposeAsync();
            }
          }
          const refresh = (next: PluginInstallRecord) =>
            refreshPersistedInstalledPluginIndexWithReceipt({
              env,
              candidates: [candidate],
              installRecords: { "package-owner": next },
              reason: "source-changed",
            });
          await refresh(record);
          const warnings: Array<{ message: string; source: string }> = [];
          const read = () => {
            const row = store.row();
            if (!row) {
              return null;
            }
            const envelope = JSON.parse(row.value_json) as { index: unknown };
            return parseInstalledPluginIndex(envelope.index);
          };
          await run({
            rootDir,
            entry,
            record,
            warnings,
            read,
            writeSnapshot: async (descriptor) => {
              const current = read()!;
              current.plugins.find((plugin) => plugin.pluginId === "demo")!.sourceSnapshot =
                descriptor;
              await store.write(current);
            },
            refresh,
            prepare: async () => {
              const prepared = await prepareInstalledPluginGenerationArtifact({
                pluginId: "demo",
                rootDir,
                source: entry,
                onWarning: (message, origin) => warnings.push({ message, source: origin }),
              });
              const snapshot = PluginSourceSnapshotDescriptorSchema.safeParse(
                read()?.plugins[0]?.sourceSnapshot,
              );
              if (snapshot.success && !owned.has(snapshot.data.artifact.path)) {
                owned.set(snapshot.data.artifact.path, snapshot.data);
              }
              return prepared;
            },
            selectInventory: () => adoptProcessPluginCache(cache),
            inventoryRetired: () => Boolean(cache.retirement),
          });
        } finally {
          await retirePluginCache(cache);
          await closeDefaultRetainedNativeWorkerSource();
          await collectPluginSourceSnapshots({
            stateDir,
            retainedPaths: new Set(),
            retiredSnapshots: [...owned.values()],
            assertCurrent() {},
          });
        }
      }),
    ),
  );
}

it("keeps the selected inventory alive while replacing an invalid named snapshot", async () => {
  try {
    await withFixture(true, async (fixture) => {
      const initial = await fixture.prepare();
      await initial.artifact.disposeAsync();
      const descriptor = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      fs.appendFileSync(path.join(descriptor.artifact.path, "manifest.json"), "corrupt");
      fixture.selectInventory();
      const prepared = await fixture.prepare();
      try {
        expect(fixture.warnings).toHaveLength(1);
        expect(fixture.inventoryRetired()).toBe(false);
        await prepared.assertCurrent();
      } finally {
        await prepared.artifact.disposeAsync();
      }
    });
  } finally {
    resetPluginCache();
  }
});

it("keeps legacy installations without a digest on the fresh capture path", async () => {
  await withFixture(false, async (fixture) => {
    const prepared = await fixture.prepare();
    try {
      expect(fs.readFileSync(prepared.artifact.resolve(fixture.entry), "utf8")).toContain(
        "installed",
      );
      expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
    } finally {
      await prepared.artifact.disposeAsync();
    }
    expect(fixture.warnings).toEqual([]);
  });
});

it("lazily publishes an eligible installation and starts again with its original tree absent", async () => {
  await withFixture(true, async (fixture) => {
    const first = await fixture.prepare();
    await first.artifact.disposeAsync();
    const snapshot = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    expect(snapshot.contentDigest).toBe(fixture.record.sourceSnapshotDigests?.demo?.contentDigest);
    fs.rmSync(fixture.rootDir, { recursive: true });
    const second = await fixture.prepare();
    try {
      expect(fs.readFileSync(second.artifact.resolve(fixture.entry), "utf8")).toContain(
        "installed",
      );
      expect(
        fs.readFileSync(
          second.artifact.resolve(path.join(fixture.rootDir, "node_modules", "dep", "index.js")),
          "utf8",
        ),
      ).toContain("dependency");
      await second.assertCurrent();
      expect(fixture.read()?.plugins[0]?.sourceSnapshot).toEqual(snapshot);
      expect(fixture.warnings).toEqual([]);
    } finally {
      await second.artifact.disposeAsync();
    }
  });
});

it.each(["capture", "publication"] as const)(
  "retains the prepared runtime when optional snapshot %s fails",
  async (stage) => {
    await withFixture(true, async (fixture) => {
      const prepareSource = worker.preparePluginSourceSnapshot;
      const failure = Object.assign(new Error("snapshot disk is full"), { code: "ENOSPC" });
      vi.spyOn(worker, "preparePluginSourceSnapshot").mockImplementationOnce(async (params) => {
        if (stage === "capture") {
          throw failure;
        }
        const source = await prepareSource(params);
        return {
          ...source,
          publish: async () => {
            throw failure;
          },
        };
      });
      const prepared = await fixture.prepare();
      try {
        expect(fs.readFileSync(prepared.artifact.resolve(fixture.entry), "utf8")).toContain(
          "installed",
        );
        await prepared.assertCurrent();
        expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
        expect(fixture.warnings).toEqual([
          expect.objectContaining({
            message: expect.stringContaining("snapshot disk is full"),
            source: fixture.rootDir,
          }),
        ]);
      } finally {
        await prepared.artifact.disposeAsync();
      }
    });
  },
);

const invalidSnapshots = [
  "integrity",
  "incomplete",
  "platform",
  "abi",
  "options",
  "recorded-owner",
] as const;
it.each(invalidSnapshots.flatMap((damage) => [false, true].map((edited) => ({ damage, edited }))))(
  "invalidates $damage and only replaces a matching original (edited=$edited)",
  async ({ damage, edited }) => {
    await withFixture(true, async (fixture) => {
      const first = await fixture.prepare();
      await first.artifact.disposeAsync();
      const bad = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      if (damage === "incomplete") {
        fs.unlinkSync(path.join(bad.artifact.path, "manifest.json"));
      } else if (damage === "options") {
        vi.stubEnv("JITI_SOURCE_MAPS", process.env.JITI_SOURCE_MAPS === "false" ? "true" : "false");
      } else {
        if (damage === "platform") {
          bad.platform = `${process.platform}-other`;
        }
        if (damage === "abi") {
          bad.abi = `${process.versions.modules}-other`;
        }
        if (damage === "integrity") {
          bad.packageIntegrity = "sha512-changed";
        }
        if (damage === "recorded-owner") {
          const identity = bad.artifact.identity.split(":");
          identity[2] = String(BigInt(identity[2]!) + 1n);
          bad.artifact.identity = identity.join(":");
        }
        await fixture.writeSnapshot(bad);
      }
      if (edited) {
        fs.writeFileSync(fixture.entry, "export const value = 'edited';\n");
      }
      const fresh = await fixture.prepare();
      try {
        expect(fs.readFileSync(fresh.artifact.resolve(fixture.entry), "utf8")).toContain(
          edited ? "edited" : "installed",
        );
        expect(fixture.warnings).toEqual([
          expect.objectContaining({
            message: expect.stringContaining(bad.artifact.path),
            source: bad.artifact.path,
          }),
        ]);
        const row = fixture.read()?.plugins[0];
        if (edited) {
          expect(row).not.toHaveProperty("sourceSnapshot");
          expect(row?.sourceSnapshotWarning?.artifactPath).toBe(bad.artifact.path);
        } else {
          const replacement = PluginSourceSnapshotDescriptorSchema.parse(row?.sourceSnapshot);
          expect(replacement.generation).not.toBe(bad.generation);
          expect(row?.sourceSnapshotWarning?.artifactPath).toBe(bad.artifact.path);
        }
      } finally {
        await fresh.artifact.disposeAsync();
        vi.unstubAllEnvs();
      }
    });
  },
);

it.each(["used", "unused"] as const)(
  "retires %s corruption at load or scrub and recaptures next start",
  async (use) => {
    await withFixture(true, async (fixture) => {
      const first = await fixture.prepare();
      await first.artifact.disposeAsync();
      const bad = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      const prepared = await fixture.prepare();
      const shared = prepared.artifact.sharedSnapshot!;
      const source =
        use === "used"
          ? fixture.entry
          : path.join(fixture.rootDir, "node_modules", "dep", "index.js");
      const member = prepared.artifact.resolve(source);
      fs.chmodSync(member, 0o600);
      fs.writeFileSync(member, "changed");
      try {
        if (use === "used") {
          let failure: unknown;
          try {
            shared.readVerifiedFile(member);
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeDefined();
          await prepared.onInvalidSnapshot?.(failure);
        } else {
          expect((await prepared.startScrub!(async () => {})).status).toBe("failed");
        }
        expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
        expect(fixture.warnings).toEqual([expect.objectContaining({ source: bad.artifact.path })]);
      } finally {
        await prepared.artifact.disposeAsync();
      }
      const next = await fixture.prepare();
      try {
        expect(
          PluginSourceSnapshotDescriptorSchema.parse(fixture.read()?.plugins[0]?.sourceSnapshot)
            .generation,
        ).not.toBe(bad.generation);
      } finally {
        await next.artifact.disposeAsync();
      }
    });
  },
);

it("retires an older format quietly and republishes only from a matching receipt", async () => {
  await withFixture(true, async (fixture) => {
    const first = await fixture.prepare();
    await first.artifact.disposeAsync();
    const older = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    older.formatVersion = 1;
    await fixture.writeSnapshot(older);
    const next = await fixture.prepare();
    try {
      expect(fixture.warnings).toEqual([]);
      expect(
        PluginSourceSnapshotDescriptorSchema.parse(fixture.read()?.plugins[0]?.sourceSnapshot)
          .formatVersion,
      ).toBe(2);
    } finally {
      await next.artifact.disposeAsync();
    }
  });
});

it("removes an unpublished candidate after a late owner swap while preserving the successor", async () => {
  await withFixture(true, async (fixture) => {
    const published = createDeferredCore();
    const resume = createDeferredCore();
    const prepareSource = worker.preparePluginSourceSnapshot;
    const prepareRuntime = worker.preparePluginGenerationArtifact;
    let candidate: PluginSourceSnapshotDescriptor["artifact"] | undefined;
    let capturedRoot: string | undefined;
    vi.spyOn(worker, "preparePluginGenerationArtifact").mockImplementationOnce(async (params) => {
      const prepared = await prepareRuntime(params);
      capturedRoot = prepared.artifact.boundaryRoot;
      return prepared;
    });
    vi.spyOn(worker, "preparePluginSourceSnapshot").mockImplementationOnce(async (params) => {
      const source = await prepareSource(params);
      return {
        ...source,
        async publish(binding) {
          const descriptor = await source.publish(binding);
          candidate = descriptor.artifact;
          published.resolve();
          await resume.promise;
          return descriptor;
        },
      };
    });
    const preparing = fixture.prepare();
    void preparing.catch(() => {});
    let successor: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
    try {
      await published.promise;
      await fixture.refresh({ ...fixture.record, spec: "demo@2.0.0" });
      successor = await fixture.prepare();
      const current = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      expect(current.artifact.path).not.toBe(candidate!.path);
      resume.resolve();
      await expect(preparing).rejects.toBeInstanceOf(PluginInventoryRetiredError);
      expect(fs.existsSync(candidate!.path)).toBe(false);
      expect(fs.existsSync(capturedRoot!)).toBe(false);
      expect(fs.existsSync(current.artifact.path)).toBe(true);
      expect(fixture.read()?.plugins[0]?.sourceSnapshot).toEqual(current);
    } finally {
      resume.resolve();
      await preparing.catch(() => {});
      await successor?.artifact.disposeAsync();
    }
  });
});

it("refuses binding and releases capture when the installed owner changes during an await", async () => {
  await withFixture(true, async (fixture) => {
    const started = createDeferredCore();
    const resume = createDeferredCore();
    const original = worker.preparePluginGenerationArtifact;
    let capturedRoot: string | undefined;
    vi.spyOn(worker, "preparePluginGenerationArtifact").mockImplementationOnce(async (params) => {
      const prepared = await original(params);
      capturedRoot = prepared.artifact.boundaryRoot;
      started.resolve();
      await resume.promise;
      return prepared;
    });
    const preparing = fixture.prepare();
    void preparing.catch(() => {});
    try {
      await started.promise;
      await fixture.refresh({ ...fixture.record, spec: "demo@2.0.0" });
    } finally {
      resume.resolve();
    }
    await expect(preparing).rejects.toBeInstanceOf(PluginInventoryRetiredError);
    expect(capturedRoot).toBeDefined();
    expect(fs.existsSync(capturedRoot!)).toBe(false);
    expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
  });
});
