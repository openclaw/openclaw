import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createTestConfigFileStore,
  createTestConfigSnapshot,
} from "../commands/test-runtime-config-helpers.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { ConfigMutationCommit } from "../config/mutate.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  getRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const configFiles = createTestConfigFileStore();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.lease.assertOwned.mockReset();
    cleanup();
  }),
);

const mocks = vi.hoisted(() => {
  const lease = {
    databasePath: "/tmp/openclaw-plugin-index.sqlite",
    signal: new AbortController().signal,
    assertOwned: vi.fn(),
    assertOwnedInTransaction: vi.fn(),
  };
  return {
    lease,
    loadInstalledPluginIndexInstallRecords: vi.fn(),
    replaceConfigFile: vi.fn(),
    restoreIndex:
      vi.fn<
        typeof import("./installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
      >(),
    transformConfigFileWithRetry: vi.fn(),
    withPluginLifecycleLease: vi.fn(
      async (_options: unknown, run: (activeLease: typeof lease) => Promise<unknown>) =>
        await run(lease),
    ),
    writeRecords:
      vi.fn<
        typeof import("./installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
      >(),
  };
});

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: true, config: {} }),
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecordsWithLease: mocks.writeRecords,
  };
});

vi.mock("./installed-plugin-index-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-store.js")>()),
  readPersistedInstalledPluginIndex: vi.fn(async () => null),
}));

vi.mock("./installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent: mocks.restoreIndex,
  };
});

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: mocks.withPluginLifecycleLease,
}));

import {
  commitConfigWithPendingPluginInstalls,
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
  stripPendingPluginInstallRecords,
  transformConfigWithPendingPluginInstalls,
} from "./install-record-commit.js";

function createManagedInstallPath(stateDir: string, generation: string, pluginId = "codex") {
  const root = path.join(stateDir, "npm", "projects", generation);
  const installPath = path.join(root, "node_modules", "@openclaw", pluginId);
  fs.mkdirSync(installPath, { recursive: true });
  return installPath;
}

function npmRecord(spec: string, installPath?: string): PluginInstallRecord {
  return { source: "npm", spec, ...(installPath ? { installPath } : {}) };
}

function managedRecord(stateDir: string, pluginId: string, version: string) {
  return {
    source: "npm" as const,
    spec: `@openclaw/${pluginId}@${version}.0.0`,
    installPath: createManagedInstallPath(stateDir, `${pluginId}-v${version}`, pluginId),
  };
}

function commitRecords(
  previousInstallRecords: Record<string, PluginInstallRecord>,
  nextInstallRecords: Record<string, PluginInstallRecord>,
  stateDir?: string,
) {
  const commit = () =>
    commitPluginInstallRecordsWithConfig({
      previousInstallRecords,
      nextInstallRecords,
      nextConfig: {},
    });
  return stateDir ? withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, commit) : commit();
}

function mark(installPath: string, pluginId: string) {
  return markRetainedManagedNpmInstall({
    packageDir: installPath,
    pluginId,
    retainedAt: "2026-04-25T00:00:00.000Z",
    reason: "test-retained-generation",
  });
}

function withInstalls(installs: Record<string, PluginInstallRecord>): OpenClawConfig {
  return { plugins: { installs } };
}

function pluginConfig(enabled: boolean): OpenClawConfig {
  return { plugins: { entries: { demo: { enabled } } } };
}

function indexWriteOptions(config: OpenClawConfig) {
  return {
    config,
    filePath: mocks.lease.databasePath,
    lease: mocks.lease,
    assertCurrent: undefined,
    onAcknowledged: expect.any(Function),
  };
}

function createRetainedMarkerFixture(stateDir: string, pluginId = "retained-fence") {
  const packageName = `@openclaw/${pluginId}`;
  const installPath = writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId,
    version: "1.0.0",
  });
  return {
    installPath,
    markerPath: resolveRetainedManagedNpmInstallMarkerPath(installPath),
    record: { source: "npm" as const, spec: `${packageName}@1.0.0`, installPath },
  };
}

function authority() {
  const auth = {
    current: true,
    failure: new Error("update authority revoked"),
    assert: () => {
      if (!auth.current) {
        throw auth.failure;
      }
    },
  };
  return auth;
}

async function expectRefusal(
  stateDir: string,
  failure: Error,
  params: Omit<Parameters<typeof commitPluginInstallRecordsWithConfig>[0], "nextConfig">,
) {
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
    expect(commitPluginInstallRecordsWithConfig({ ...params, nextConfig: {} })).rejects.toBe(
      failure,
    ),
  );
}

function markFixture(fixture: ReturnType<typeof createRetainedMarkerFixture>) {
  return markRetainedManagedNpmInstall({
    packageDir: fixture.installPath,
    pluginId: "retained-fence",
    reason: "retained-package",
  });
}

describe("commitConfigWithPendingPluginInstalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    configFiles.clear();
    mocks.replaceConfigFile.mockImplementation(async (params: { nextConfig: OpenClawConfig }) =>
      configFiles.write(params.nextConfig),
    );
    mocks.restoreIndex.mockResolvedValue(true);
    mocks.writeRecords.mockResolvedValue({
      previous: null,
      revision: 1,
      mutation: {
        databasePath: "/tmp/openclaw.sqlite",
        before: null,
        after: { state_key: "plugins.installedIndex", value_json: "{}", updated_at_ms: 1 },
      },
    });
  });

  it.each([false, true])("commits config with pending records: %s", async (pending) => {
    const existing = { existing: npmRecord("existing@1.0.0") };
    const installs = { demo: npmRecord("demo@1.0.0") };
    const strippedConfig: OpenClawConfig = pending
      ? pluginConfig(true)
      : { gateway: { mode: "local" } };
    const nextConfig = pending
      ? { plugins: { ...strippedConfig.plugins, installs } }
      : strippedConfig;
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(pending ? existing : {});
    const result = await commitConfigWithPendingPluginInstalls({
      nextConfig,
      ...(pending ? { baseHash: "config-1" } : {}),
    });
    if (pending) {
      expect(mocks.writeRecords).toHaveBeenCalledWith(
        { ...existing, ...installs },
        indexWriteOptions(strippedConfig),
      );
    } else {
      expect(mocks.writeRecords).not.toHaveBeenCalled();
    }
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: strippedConfig,
      ...(pending
        ? { baseHash: "config-1", writeOptions: { unsetPaths: [["plugins", "installs"]] } }
        : {}),
    });
    expect(result).toMatchObject({
      path: "/tmp/openclaw.json",
      nextConfig: strippedConfig,
      movedInstallRecords: pending,
      persistedHash: "test-config-hash",
    });
  });

  it("uses the effective config for records-only index commits", async () => {
    const nextConfig = pluginConfig(false);
    const nextInstallRecords = { demo: npmRecord("demo@2.0.0") };
    const verifyConfigFresh = vi.fn(async () => undefined);

    await commitPluginInstallRecordsOnly({
      nextConfig,
      nextInstallRecords,
      verifyConfigFresh,
    });

    expect(mocks.writeRecords).toHaveBeenCalledWith(
      nextInstallRecords,
      indexWriteOptions(nextConfig),
    );
    expect(verifyConfigFresh).toHaveBeenCalledOnce();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("migrates source records below the canonical index and explicit pending records", async () => {
    const sourceConfig = withInstalls({
      stale: npmRecord("stale@1.0.0"),
      missing: npmRecord("missing@1.0.0"),
      codex: npmRecord("codex@1.0.0"),
      constructor: npmRecord("constructor@1.0.0"),
      ["__proto__"]: npmRecord("proto@1.0.0"),
    });
    const existingRecords: Record<string, PluginInstallRecord> = {
      stale: npmRecord("stale@2.0.0"),
      codex: npmRecord("codex@2.0.0"),
      constructor: npmRecord("constructor@2.0.0"),
      ["__proto__"]: npmRecord("proto@2.0.0"),
    };
    const nextConfig = withInstalls({
      ...sourceConfig.plugins?.installs,
      codex: npmRecord("codex@3.0.0"),
      concurrent: npmRecord("concurrent@1.0.0"),
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(existingRecords);
    const snapshot = createTestConfigSnapshot(sourceConfig);
    mocks.transformConfigFileWithRetry.mockImplementationOnce(
      async (params: { commit: ConfigMutationCommit }) =>
        await params.commit({ nextConfig, snapshot, afterWrite: { mode: "auto" } }),
    );

    await transformConfigWithPendingPluginInstalls({
      transform: () => ({ nextConfig }),
    });

    expect(mocks.writeRecords).toHaveBeenCalledWith(
      {
        stale: existingRecords.stale,
        missing: sourceConfig.plugins?.installs?.missing,
        codex: nextConfig.plugins?.installs?.codex,
        concurrent: nextConfig.plugins?.installs?.concurrent,
        constructor: existingRecords.constructor,
        ["__proto__"]: npmRecord("proto@2.0.0"),
      },
      indexWriteOptions({}),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      snapshot,
      writeOptions: {
        unsetPaths: [["plugins", "installs"]],
      },
    });
    expect(Object.getPrototypeOf(mocks.writeRecords.mock.calls[0]?.[0])).toBeNull();
  });

  it.each([undefined, { mode: "restart", reason: "test restart" }] as const)(
    "preserves source records and the runtime application receipt with intent %j",
    async (afterWrite) => {
      const sourceConfig = withInstalls({ other: npmRecord("other@1.0.0") });
      const codexRecord = npmRecord("codex@2.0.0");
      const snapshot = { sourceConfig };
      const application = createRuntimeConfigWriteApplication();
      mocks.replaceConfigFile.mockImplementationOnce(
        async (params: { nextConfig: OpenClawConfig; writeOptions: ConfigWriteOptions }) => {
          getRuntimeConfigWriteApplication(params.writeOptions)?.claim()?.settle("applied");
          return { nextConfig: params.nextConfig, persistedHash: "test-config-hash" };
        },
      );
      mocks.transformConfigFileWithRetry.mockImplementationOnce(async (params: unknown) => {
        const transformParams = params as {
          writeOptions?: ConfigWriteOptions;
          transform: (
            config: OpenClawConfig,
            context: { snapshot: typeof snapshot },
          ) => { nextConfig: OpenClawConfig };
          commit: (input: unknown) => Promise<unknown>;
        };
        const transformed = transformParams.transform(sourceConfig, { snapshot });
        return await transformParams.commit({
          nextConfig: transformed.nextConfig,
          snapshot,
          writeOptions: transformParams.writeOptions,
        });
      });

      const result = await transformConfigWithPendingPluginInstalls({
        afterWrite,
        writeOptions: attachRuntimeConfigWriteApplication({}, application),
        transform: () => ({
          nextConfig: withInstalls({ codex: codexRecord }),
        }),
      });
      expect(result.afterWrite).toEqual(afterWrite ?? { mode: "auto" });
      expect(mocks.replaceConfigFile.mock.calls[0]?.[0].writeOptions.afterWrite).toEqual(
        afterWrite,
      );
      expect(application.claimed).toBe(true);
      await expect(application.result).resolves.toBe("applied");

      expect(mocks.writeRecords).toHaveBeenCalledWith(
        {
          other: sourceConfig.plugins?.installs?.other,
          codex: codexRecord,
        },
        indexWriteOptions({}),
      );
    },
  );

  it("handles prototype-named pending records with own-key semantics", () => {
    const constructorRecord = { source: "npm" as const, spec: "constructor@1.0.0" };
    const toStringRecord = { source: "path" as const };
    const protoRecord = { source: "git" as const };
    const installs = createPluginInstallRecordMap<PluginInstallRecord>();
    setPluginInstallRecordMapEntry(installs, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(installs, "toString", toStringRecord);
    setPluginInstallRecordMapEntry(installs, "__proto__", protoRecord);
    const nextConfig = { plugins: { installs } } satisfies OpenClawConfig;

    const stripped = stripPendingPluginInstallRecords(nextConfig, ["__proto__"]);
    const remaining = stripped.plugins?.installs;
    expect(Object.getPrototypeOf(remaining)).toBeNull();
    expect(Object.hasOwn(remaining ?? {}, "__proto__")).toBe(false);
    expect(getPluginInstallRecordMapEntry(remaining, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(remaining, "toString")).toBe(toStringRecord);
  });

  it("does not mark arbitrary npm paths outside the managed npm root", async () => {
    const stateDir = tempDirs.make("openclaw-record-commit-");
    const outsideRoot = tempDirs.make("openclaw-record-outside-");
    const previous = managedRecord(outsideRoot, "codex", "1");
    const next = managedRecord(stateDir, "codex", "2");

    await commitRecords({ codex: previous }, { codex: next }, stateDir);

    expect(hasRetainedManagedNpmInstallMarker(previous.installPath)).toBe(false);
  });

  it("marks replaced npm generations across install record id migrations", async () => {
    const stateDir = tempDirs.make("openclaw-record-commit-");
    const previous = managedRecord(stateDir, "voice-call", "1");
    const next = managedRecord(stateDir, "voice-call", "2");

    await commitRecords({ "voice-call": previous }, { "@openclaw/voice-call": next }, stateDir);

    expect(hasRetainedManagedNpmInstallMarker(previous.installPath)).toBe(true);
  });

  it("removes earlier retained markers when a later marker creation fails", async () => {
    const stateDir = tempDirs.make("openclaw-record-commit-");
    const records = (version: string) => ({
      codex: managedRecord(stateDir, "codex", version),
      "voice-call": managedRecord(stateDir, "voice-call", version),
    });
    const previous = records("1");
    const next = records("2");
    fs.writeFileSync(
      path.join(stateDir, "npm", "projects", "voice-call-v1", ".openclaw-retained-npm-installs"),
      "not a directory",
      "utf8",
    );

    await expect(commitRecords(previous, next, stateDir)).rejects.toThrow();

    expect(hasRetainedManagedNpmInstallMarker(previous.codex.installPath)).toBe(false);
  });

  it("restores earlier active markers when clearing a later marker fails", async () => {
    const stateDir = tempDirs.make("openclaw-record-commit-");
    const installPaths = ["codex", "voice-call"].map((pluginId) =>
      createManagedInstallPath(stateDir, `${pluginId}-v2`, pluginId),
    );
    for (const [index, installPath] of installPaths.entries()) {
      await mark(installPath, index === 0 ? "codex" : "voice-call");
    }
    const laterMarkerPath = resolveRetainedManagedNpmInstallMarkerPath(installPaths[1] ?? "");
    const realRm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === laterMarkerPath) {
        const error = new Error("marker clear failed") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return await realRm(target, options);
    });

    try {
      await expect(
        commitRecords(
          {},
          Object.fromEntries(
            installPaths.map((installPath, index) => {
              const pluginId = index === 0 ? "codex" : "voice-call";
              return [pluginId, npmRecord(`@openclaw/${pluginId}@2.0.0`, installPath)];
            }),
          ),
        ),
      ).rejects.toThrow("marker clear failed");

      expect(installPaths.every(hasRetainedManagedNpmInstallMarker)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("leaves marker state intact when a successor owns the plugin index", async () => {
    const stateDir = tempDirs.make("openclaw-record-commit-");
    const installPath = createManagedInstallPath(stateDir, "codex-v2");
    await mark(installPath, "codex");
    mocks.restoreIndex.mockResolvedValueOnce(false);
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

    await expect(
      commitRecords({}, { codex: npmRecord("@openclaw/codex@2.0.0", installPath) }),
    ).rejects.toThrow("config changed");
    expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
  });
  describe("plugin install record marker fencing", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset();
    });

    it.each([
      ["retirement", "lease", "preparation"],
      ["retirement", "invoker", "preparation"],
      ["activation", "lease", "preparation"],
      ["activation", "invoker", "removal"],
      ["activation", "invoker", "directory cleanup"],
    ] as const)(
      "fences awaited %s markers using %s authority at %s",
      async (transition, owner, boundary) => {
        const stateDir = tempDirs.make("openclaw-record-marker-fence-");
        const fixture = createRetainedMarkerFixture(stateDir);
        if (transition === "activation") {
          await markFixture(fixture);
        }
        const before =
          transition === "activation" ? fs.readFileSync(fixture.markerPath, "utf8") : undefined;
        const siblingMarker = path.join(path.dirname(fixture.markerPath), "unrelated.json");
        if (boundary === "directory cleanup") {
          fs.writeFileSync(siblingMarker, "unrelated marker");
        }
        const records = { "retained-fence": fixture.record };
        const auth = authority();
        const targetPath =
          boundary === "preparation" && transition === "retirement"
            ? fixture.installPath
            : boundary === "directory cleanup"
              ? path.dirname(fixture.markerPath)
              : fixture.markerPath;
        const after = async <T>(operation: Promise<T>, target: unknown) => {
          let completed = false;
          try {
            const result = await operation;
            completed = true;
            return result;
          } finally {
            if ((completed || boundary === "directory cleanup") && String(target) === targetPath) {
              auth.current = false;
            }
          }
        };
        const stat = fs.promises.stat.bind(fs.promises);
        const readFile = fs.promises.readFile.bind(fs.promises);
        const rm = fs.promises.rm.bind(fs.promises);
        const rmdir = fs.promises.rmdir.bind(fs.promises);
        if (boundary === "preparation" && transition === "retirement") {
          vi.spyOn(fs.promises, "stat").mockImplementation((target, options) =>
            after(stat(target, options), target),
          );
        } else if (boundary === "preparation") {
          vi.spyOn(fs.promises, "readFile").mockImplementation((target, options) =>
            after(readFile(target, options), target),
          );
        } else if (boundary === "removal") {
          vi.spyOn(fs.promises, "rm").mockImplementation((target, options) =>
            after(rm(target, options), target),
          );
        } else {
          vi.spyOn(fs.promises, "rmdir").mockImplementation((target) =>
            after(rmdir(target), target),
          );
        }
        if (owner === "lease") {
          mocks.lease.assertOwned.mockImplementation(auth.assert);
        }
        await expectRefusal(stateDir, auth.failure, {
          previousInstallRecords: transition === "retirement" ? records : {},
          nextInstallRecords: transition === "activation" ? records : {},
          ...(owner === "invoker"
            ? { writeOptions: { assertConfigPathForWrite: auth.assert } }
            : {}),
        });
        expect(auth.current).toBe(false);
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(mocks.restoreIndex).toHaveBeenCalledTimes(owner === "invoker" ? 1 : 0);
        if (before !== undefined) {
          expect(fs.readFileSync(fixture.markerPath, "utf8")).toBe(before);
        } else {
          expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(false);
        }
        expect(fs.existsSync(fixture.installPath)).toBe(true);
        if (boundary === "directory cleanup") {
          expect(fs.readFileSync(siblingMarker, "utf8")).toBe("unrelated marker");
        }
      },
    );

    it("preserves later retirement markers when rollback loses authority after an awaited removal", async () => {
      const stateDir = tempDirs.make("openclaw-record-marker-rollback-fence-");
      const first = createRetainedMarkerFixture(stateDir, "first-retained");
      const second = createRetainedMarkerFixture(stateDir, "second-retained");
      const auth = authority();
      const rm = fs.promises.rm.bind(fs.promises);
      vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        await rm(target, options);
        if (String(target) === first.markerPath) {
          auth.current = false;
        }
      });
      mocks.lease.assertOwned.mockImplementation(auth.assert);
      let markerBeforeRollback = "";
      mocks.replaceConfigFile.mockImplementationOnce(async () => {
        markerBeforeRollback = fs.readFileSync(second.markerPath, "utf8");
        throw new Error("config changed");
      });
      await expectRefusal(stateDir, auth.failure, {
        previousInstallRecords: {
          "first-retained": first.record,
          "second-retained": second.record,
        },
        nextInstallRecords: {},
      });
      expect(mocks.restoreIndex).toHaveBeenCalledOnce();
      expect(fs.existsSync(first.markerPath)).toBe(false);
      expect(markerBeforeRollback).not.toBe("");
      expect(fs.readFileSync(second.markerPath, "utf8")).toBe(markerBeforeRollback);
      expect(fs.existsSync(first.installPath)).toBe(true);
      expect(fs.existsSync(second.installPath)).toBe(true);
    });

    it("fences marker restoration after rollback directory preparation loses authority", async () => {
      const stateDir = tempDirs.make("openclaw-record-marker-restore-fence-");
      const fixture = createRetainedMarkerFixture(stateDir);
      await markFixture(fixture);
      const auth = authority();
      const mkdir = fs.promises.mkdir.bind(fs.promises);
      vi.spyOn(fs.promises, "mkdir").mockImplementation(async (target, options) => {
        const result = await mkdir(target, options);
        if (String(target) === path.dirname(fixture.markerPath)) {
          auth.current = false;
        }
        return result;
      });
      mocks.lease.assertOwned.mockImplementation(auth.assert);
      mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));
      await expectRefusal(stateDir, auth.failure, {
        previousInstallRecords: {},
        nextInstallRecords: { "retained-fence": fixture.record },
      });
      expect(auth.current).toBe(false);
      expect(mocks.restoreIndex).toHaveBeenCalledOnce();
      expect(fs.existsSync(fixture.markerPath)).toBe(false);
      expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(true);
      expect(fs.existsSync(fixture.installPath)).toBe(true);
    });
  });
});
