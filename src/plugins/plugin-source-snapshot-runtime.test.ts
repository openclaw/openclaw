import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import {
  resolveActivePluginInstallRoots,
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "./install-root-context.js";
import { indexStoreFixture } from "./installed-plugin-index-family.test-support.js";
import { refreshPersistedInstalledPluginIndexWithReceipt } from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import * as installedIndex from "./installed-plugin-index-store.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  resetPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import * as worker from "./plugin-generation-worker.js";
import { PluginInventoryRetiredError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginSharedSnapshotModuleLoader } from "./plugin-shared-snapshot-module-loader.js";
import { createPluginSnapshotChildHost } from "./plugin-snapshot-child-host.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import type { ManagedPluginSnapshotIdentity } from "./plugin-source-snapshot-options.js";
import { prepareInstalledPluginGenerationArtifact } from "./plugin-source-snapshot-runtime.js";
import {
  createPluginSnapshotScrubOwner,
  registerPluginSnapshotScrub,
} from "./plugin-source-snapshot-scrub.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";
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
    prepare: (
      installation?: ManagedPluginSnapshotIdentity,
    ) => ReturnType<typeof prepareInstalledPluginGenerationArtifact>;
    preparePublished: (
      installation?: ManagedPluginSnapshotIdentity,
    ) => ReturnType<typeof prepareInstalledPluginGenerationArtifact>;
    removeInstallation: () => Promise<unknown>;
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
  const source = "export const value = 'installed'; export const deferred = () => import('dep');\n";
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
            const index = parseInstalledPluginIndex(envelope.index);
            const snapshot = PluginSourceSnapshotDescriptorSchema.safeParse(
              index?.plugins[0]?.sourceSnapshot,
            );
            if (snapshot.success && !owned.has(snapshot.data.artifact.path)) {
              owned.set(snapshot.data.artifact.path, snapshot.data);
            }
            return index;
          };
          const prepare = async (
            installation = {
              installOwner: "package-owner",
              installRecordHash: read()!.plugins[0]!.installRecordHash!,
            },
          ) =>
            await prepareInstalledPluginGenerationArtifact({
              installation,
              pluginId: "demo",
              rootDir,
              source: entry,
              onWarning: (message, origin) => warnings.push({ message, source: origin }),
            });
          const preparePublished = async (installation?: ManagedPluginSnapshotIdentity) => {
            const prepared = await prepare(installation);
            try {
              if (!prepared.artifact.sharedSnapshot) {
                await prepared.startScrub?.(async () => {});
              }
              read();
              return prepared;
            } catch (error) {
              await prepared.artifact.disposeAsync();
              throw error;
            }
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
            removeInstallation: () =>
              refreshPersistedInstalledPluginIndexWithReceipt({
                env,
                candidates: [],
                installRecords: {},
                reason: "source-changed",
              }),
            prepare,
            preparePublished,
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

it("defers lazy publication until the registered post-ready owner starts", async () => {
  await withFixture(true, async (fixture) => {
    const source = worker.preparePluginSourceSnapshot;
    const publish = vi.spyOn(worker, "preparePluginSourceSnapshot").mockImplementation((params) => {
      expect(resolveActivePluginInstallRoots().stateDir).toBe(path.dirname(fixture.rootDir));
      return source(params);
    });
    const metrics = createPluginGenerationMetrics();
    const prepared = await withPluginGenerationMetrics(metrics, () => fixture.prepare());
    const startupMetrics = { ...metrics };
    const capturedRoot = prepared.artifact.boundaryRoot;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "demo" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const owner = createPluginSnapshotScrubOwner(registry);
    try {
      expect(publish).not.toHaveBeenCalled();
      expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
      expect(prepared.startScrub).toBeTypeOf("function");
      registerPluginSnapshotScrub(
        instance,
        () => prepared.startScrub!(async () => {}),
        async () => prepared.cancelScrub?.(),
      );
      await nextTurn();
      expect(publish).not.toHaveBeenCalled();
      const otherRoots = resolvePluginInstallRoots({
        ...process.env,
        OPENCLAW_STATE_DIR: temp.make("publication-caller-"),
      });
      expect(await withPluginInstallRoots(otherRoots, () => owner.start())).toEqual([
        { status: "passed" },
      ]);
      expect(metrics).toEqual(startupMetrics);
      expect(publish).toHaveBeenCalledOnce();
      const descriptor = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      expect(descriptor.contentDigest).toBe(
        fixture.record.sourceSnapshotDigests?.demo?.contentDigest,
      );
      expect(prepared.artifact.boundaryRoot).toBe(capturedRoot);
      expect(prepared.artifact.sharedSnapshot).toBeUndefined();
      await prepared.assertCurrent();
    } finally {
      await owner.stop();
      await instance.dispose();
      await prepared.artifact.disposeAsync();
    }
  });
});

it("cancels unpublished post-ready work before dispatch", async () => {
  await withFixture(true, async (fixture) => {
    const publish = vi.spyOn(worker, "preparePluginSourceSnapshot");
    const prepared = await fixture.prepare();
    try {
      expect(publish).not.toHaveBeenCalled();
      const work = prepared.startScrub!(async () => {});
      await prepared.cancelScrub?.();
      expect((await work).status).toBe("cancelled");
      expect(publish).not.toHaveBeenCalled();
      expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
    } finally {
      await prepared.artifact.disposeAsync();
    }
  });
});

it.each(["cancel", "dispose"] as const)(
  "joins an in-flight publication capture before %s releases its custody",
  async (ending) => {
    await withFixture(true, async (fixture) => {
      const captured = createDeferredCore();
      const resume = createDeferredCore();
      const original = worker.preparePluginSourceSnapshot;
      const disposed = vi.fn();
      let signal: AbortSignal | undefined;
      vi.spyOn(worker, "preparePluginSourceSnapshot").mockImplementationOnce(async (params) => {
        signal = params.backgroundSignal;
        const snapshot = await original(params);
        captured.resolve();
        await resume.promise;
        return {
          ...snapshot,
          disposeAsync: async () => {
            await snapshot.disposeAsync();
            disposed();
          },
        };
      });
      const prepared = await fixture.prepare();
      const publication = prepared.startScrub!(async () => {});
      let joined = false;
      try {
        await captured.promise;
        if (ending === "dispose") {
          prepared.artifact.dispose();
        }
        const cancel = (
          ending === "dispose" ? prepared.artifact.disposeAsync() : prepared.cancelScrub!()
        ).then(() => {
          joined = true;
        });
        expect(signal?.aborted).toBe(true);
        await nextTurn();
        expect(joined).toBe(false);
        expect(fs.existsSync(prepared.artifact.boundaryRoot)).toBe(true);
        resume.resolve();
        await cancel;
        expect((await publication).status).toBe("cancelled");
        expect(disposed).toHaveBeenCalledOnce();
        expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
      } finally {
        resume.resolve();
        await publication;
        await prepared.artifact.disposeAsync();
      }
    });
  },
);

it("retires the capture when background publication cannot verify install authority", async () => {
  await withFixture(true, async (fixture) => {
    const prepared = await fixture.prepare();
    const onFailure = vi.fn(async () => {});
    const read = vi
      .spyOn(installedIndex, "readCurrentInstalledPluginIndex")
      .mockRejectedValue(new Error("installation authority is unavailable"));
    try {
      expect(await prepared.startScrub!(onFailure)).toMatchObject({
        status: "failed",
        error: expect.any(PluginInventoryRetiredError),
      });
      expect(onFailure).toHaveBeenCalledWith(expect.any(PluginInventoryRetiredError));
      read.mockRestore();
      await expect(prepared.assertCurrent()).rejects.toBeInstanceOf(PluginInventoryRetiredError);
      expect(fixture.warnings[0]?.message).toContain("Retiring this runtime instance");
    } finally {
      read.mockRestore();
      await prepared.artifact.disposeAsync();
    }
  });
});

it("converges concurrent lazy publishers without replacing either first capture", async () => {
  await withFixture(true, async (fixture) => {
    const first = await fixture.prepare();
    const second = await fixture.prepare();
    const onFailure = vi.fn(async () => {});
    try {
      const roots = [first.artifact.boundaryRoot, second.artifact.boundaryRoot];
      const outcomes = await Promise.all([
        first.startScrub!(onFailure),
        second.startScrub!(onFailure),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed", "passed"]);
      expect(onFailure).not.toHaveBeenCalled();
      expect([first.artifact.boundaryRoot, second.artifact.boundaryRoot]).toEqual(roots);
      expect(roots.every((root) => fs.existsSync(root))).toBe(true);
      await first.assertCurrent();
      await second.assertCurrent();
      expect(
        PluginSourceSnapshotDescriptorSchema.safeParse(fixture.read()?.plugins[0]?.sourceSnapshot)
          .success,
      ).toBe(true);
    } finally {
      await first.artifact.disposeAsync();
      await second.artifact.disposeAsync();
    }
  });
});

it.each(["removed", "replaced"] as const)(
  "rejects a %s installation before preparing a stale managed candidate",
  async (change) => {
    await withFixture(true, async (fixture) => {
      const installation = {
        installOwner: "package-owner",
        installRecordHash: fixture.read()!.plugins[0]!.installRecordHash!,
      };
      if (change === "removed") {
        await fixture.removeInstallation();
      } else {
        await fixture.refresh({ ...fixture.record, spec: "demo@2.0.0" });
      }
      const prepare = vi.spyOn(worker, "preparePluginGenerationArtifact");
      const outcome = await fixture.prepare(installation).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await outcome.value?.artifact.disposeAsync();
      expect(outcome.error).toBeInstanceOf(PluginInventoryRetiredError);
      expect(prepare).not.toHaveBeenCalled();
    });
  },
);

it("keeps the selected inventory alive while replacing an invalid named snapshot", async () => {
  try {
    await withFixture(true, async (fixture) => {
      const initial = await fixture.preparePublished();
      await initial.artifact.disposeAsync();
      const descriptor = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      fs.appendFileSync(path.join(descriptor.artifact.path, "manifest.json"), "corrupt");
      fixture.selectInventory();
      const prepared = await fixture.preparePublished();
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

it("allows raw child reads, then retires corruption at scrub and recaptures next start", async () => {
  await withFixture(true, async (fixture) => {
    const first = await fixture.preparePublished();
    await first.artifact.disposeAsync();
    const bad = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    const prepared = await fixture.preparePublished();
    const host = createPluginSnapshotChildHost({ snapshot: prepared.artifact.sharedSnapshot! });
    const childPath = prepared.artifact.resolve(
      path.join(fixture.rootDir, "node_modules", "dep", "index.js"),
    );
    const { spawn } = host.loadBuiltin("node:child_process") as typeof import("node:child_process");
    const launch = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [childPath], {
          env: { ...process.env, NODE_OPTIONS: "" },
        });
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          errors += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
      });
    try {
      expect(await launch()).toBe("");
      fs.chmodSync(childPath, 0o600);
      fs.writeFileSync(childPath, "console.log('changed child bytes');\n");
      // Raw execution is deliberately outside the verified loader, like raw asset reads.
      expect(await launch()).toBe("changed child bytes\n");
      expect(fixture.warnings).toEqual([]);
      expect((await prepared.startScrub!(async () => {})).status).toBe("failed");
      expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
      expect(fixture.warnings).toEqual([
        expect.objectContaining({
          source: bad.artifact.path,
          message: expect.stringContaining("index.js"),
        }),
      ]);
      expect(fixture.read()?.plugins[0]?.sourceSnapshotWarning?.artifactPath).toBe(
        bad.artifact.path,
      );
    } finally {
      await host.disposeAsync();
      await prepared.artifact.disposeAsync();
    }
    const next = await fixture.preparePublished();
    try {
      expect(
        PluginSourceSnapshotDescriptorSchema.parse(fixture.read()?.plugins[0]?.sourceSnapshot)
          .generation,
      ).not.toBe(bad.generation);
      expect(fs.readFileSync(next.artifact.resolve(fixture.entry), "utf8")).toContain("installed");
    } finally {
      await next.artifact.disposeAsync();
    }
  });
});

it("keeps legacy installations without a digest on the fresh capture path", async () => {
  await withFixture(false, async (fixture) => {
    const prepared = await fixture.preparePublished();
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
    const first = await fixture.preparePublished();
    await first.artifact.disposeAsync();
    const snapshot = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    expect(snapshot.contentDigest).toBe(fixture.record.sourceSnapshotDigests?.demo?.contentDigest);
    fs.rmSync(fixture.rootDir, { recursive: true });
    const second = await fixture.preparePublished();
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
      const prepared = await fixture.preparePublished();
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
      const first = await fixture.preparePublished();
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
      const fresh = await fixture.preparePublished();
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

it.each(
  (["used", "unused"] as const).flatMap((use) =>
    (process.platform === "win32" ? (["bytes"] as const) : (["bytes", "permissions"] as const)).map(
      (damage) => ({ use, damage }),
    ),
  ),
)(
  "retires $use $damage corruption at load or scrub and recaptures next start",
  async ({ use, damage }) => {
    await withFixture(true, async (fixture) => {
      const first = await fixture.preparePublished();
      await first.artifact.disposeAsync();
      const bad = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      const prepared = await fixture.preparePublished();
      const shared = prepared.artifact.sharedSnapshot!;
      const source =
        use === "used"
          ? fixture.entry
          : path.join(fixture.rootDir, "node_modules", "dep", "index.js");
      const member = prepared.artifact.resolve(source);
      fs.chmodSync(member, damage === "permissions" ? 0o666 : 0o600);
      if (damage === "bytes") {
        fs.writeFileSync(member, "changed");
      }
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
      const next = await fixture.preparePublished();
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
    const first = await fixture.preparePublished();
    await first.artifact.disposeAsync();
    const older = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    older.formatVersion = 1;
    await fixture.writeSnapshot(older);
    const next = await fixture.preparePublished();
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
    const first = await fixture.prepare();
    const onFailure = vi.fn(async () => {});
    const publishing = first.startScrub!(onFailure);
    let successor: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
    try {
      await published.promise;
      await fixture.refresh({ ...fixture.record, spec: "demo@2.0.0" });
      successor = await fixture.preparePublished();
      const current = PluginSourceSnapshotDescriptorSchema.parse(
        fixture.read()?.plugins[0]?.sourceSnapshot,
      );
      expect(current.artifact.path).not.toBe(candidate!.path);
      resume.resolve();
      expect(await publishing).toMatchObject({
        status: "failed",
        error: expect.any(PluginInventoryRetiredError),
      });
      expect(onFailure).toHaveBeenCalledWith(expect.any(PluginInventoryRetiredError));
      await expect(first.assertCurrent()).rejects.toBeInstanceOf(PluginInventoryRetiredError);
      expect(fs.existsSync(candidate!.path)).toBe(false);
      // The old instance is quiesced by its loader owner; custody remains until disposal.
      expect(fs.existsSync(capturedRoot!)).toBe(true);
      expect(fs.existsSync(current.artifact.path)).toBe(true);
      expect(fixture.read()?.plugins[0]?.sourceSnapshot).toEqual(current);
    } finally {
      resume.resolve();
      await publishing;
      await first.artifact.disposeAsync();
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
    const preparing = fixture.preparePublished();
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

it("automatically retires a snapshot after a deferred module verification failure", async () => {
  await withFixture(true, async (fixture) => {
    const first = await fixture.preparePublished();
    await first.artifact.disposeAsync();
    const descriptor = PluginSourceSnapshotDescriptorSchema.parse(
      fixture.read()?.plugins[0]?.sourceSnapshot,
    );
    const prepared = await fixture.preparePublished();
    const instance = new PluginInstance("demo");
    bindPluginSharedSnapshotModuleLoader(
      {
        instance,
        origin: "global",
        source: fixture.entry,
        rootDir: fixture.rootDir,
        preparedArtifact: prepared,
      },
      () => {
        throw new Error("unexpected recovery");
      },
    );
    try {
      const loaded = instance.loadModule(fixture.entry) as {
        deferred: () => Promise<unknown>;
      };
      const dependency = prepared.artifact.resolve(
        path.join(fixture.rootDir, "node_modules", "dep", "index.js"),
      );
      fs.chmodSync(dependency, 0o600);
      fs.writeFileSync(dependency, "module.exports = 'altered';\n");
      await expect(loaded.deferred()).rejects.toMatchObject({
        code: "PLUGIN_SOURCE_SNAPSHOT_INVALID",
      });
      // Disposal joins owner-held retirement without explicitly reporting the failure.
      await instance.dispose();
      expect(fixture.read()?.plugins[0]).not.toHaveProperty("sourceSnapshot");
      expect(fixture.read()?.plugins[0]?.sourceSnapshotWarning?.artifactPath).toBe(
        descriptor.artifact.path,
      );
      expect(fixture.warnings).toHaveLength(1);
      expect(fixture.warnings[0]?.message).toContain("Retiring this snapshot");
    } finally {
      await instance.dispose();
      await prepared.artifact.disposeAsync();
    }
  });
});
