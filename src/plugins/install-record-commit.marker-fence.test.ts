import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => {
  const lease = {
    databasePath: "/tmp/openclaw-plugin-index.sqlite",
    signal: new AbortController().signal,
    assertOwned: vi.fn(),
    assertOwnedInTransaction: vi.fn(),
  };
  return {
    lease,
    replaceConfigFile: vi.fn(),
    restorePersistedInstalledPluginIndexIfCurrent:
      vi.fn<
        typeof import("./installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
      >(),
    withPluginLifecycleLease: vi.fn(
      async (_options: unknown, run: (activeLease: typeof lease) => Promise<unknown>) =>
        await run(lease),
    ),
    writePersistedInstalledPluginIndexInstallRecordsWithLease:
      vi.fn<
        typeof import("./installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
      >(),
  };
});

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: true, config: {} }),
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: vi.fn(),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
  return {
    ...actual,
    writePersistedInstalledPluginIndexInstallRecordsWithLease:
      mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
  };
});

vi.mock("./installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent:
      mocks.restorePersistedInstalledPluginIndexIfCurrent,
  };
});

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: mocks.withPluginLifecycleLease,
}));

import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";

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

describe("plugin install record marker fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replaceConfigFile.mockReset();
    mocks.restorePersistedInstalledPluginIndexIfCurrent.mockResolvedValue(true);
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: null,
      revision: 1,
      mutation: {
        databasePath: "/tmp/openclaw.sqlite",
        before: null,
        after: { state_key: "plugins.installedIndex", value_json: "{}", updated_at_ms: 1 },
      },
    });
  });

  it.each(["retirement", "activation"] as const)(
    "carries live lease authority through awaited %s marker preparation",
    async (transition) => {
      const stateDir = retentionTempDirs.make("openclaw-record-marker-fence-");
      const fixture = createRetainedMarkerFixture(stateDir);
      if (transition === "activation") {
        await markRetainedManagedNpmInstall({
          packageDir: fixture.installPath,
          pluginId: "retained-fence",
          reason: "retained-package",
        });
      }
      const before =
        transition === "activation" ? fs.readFileSync(fixture.markerPath, "utf8") : undefined;
      const records = { "retained-fence": fixture.record };
      const failure = new Error("update authority revoked during marker preparation");
      let current = true;
      const stat = fs.promises.stat.bind(fs.promises);
      const readFile = fs.promises.readFile.bind(fs.promises);
      const statSpy = vi.spyOn(fs.promises, "stat").mockImplementation(async (target, options) => {
        const result = await stat(target, options);
        if (transition === "retirement" && String(target) === fixture.installPath) {
          current = false;
        }
        return result;
      });
      const readSpy = vi
        .spyOn(fs.promises, "readFile")
        .mockImplementation(async (target, options) => {
          const result = await readFile(target, options);
          if (transition === "activation" && target === fixture.markerPath) {
            current = false;
          }
          return result;
        });
      mocks.lease.assertOwned.mockImplementation(() => {
        if (!current) {
          throw failure;
        }
      });
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          await expect(
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords: transition === "retirement" ? records : {},
              nextInstallRecords: transition === "activation" ? records : {},
              nextConfig: {},
            }),
          ).rejects.toBe(failure);
        });
        expect(current).toBe(false);
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(mocks.restorePersistedInstalledPluginIndexIfCurrent).not.toHaveBeenCalled();
        if (before !== undefined) {
          expect(fs.readFileSync(fixture.markerPath, "utf8")).toBe(before);
        } else {
          expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(false);
        }
        expect(fs.existsSync(fixture.installPath)).toBe(true);
      } finally {
        statSpy.mockRestore();
        readSpy.mockRestore();
        mocks.lease.assertOwned.mockReset();
      }
    },
  );

  it("preserves later retirement markers when rollback loses authority after an awaited removal", async () => {
    const stateDir = retentionTempDirs.make("openclaw-record-marker-rollback-fence-");
    const first = createRetainedMarkerFixture(stateDir, "first-retained");
    const second = createRetainedMarkerFixture(stateDir, "second-retained");
    const failure = new Error("update authority revoked during marker compensation");
    let current = true;
    const rm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      await rm(target, options);
      if (String(target) === first.markerPath) {
        current = false;
      }
    });
    mocks.lease.assertOwned.mockImplementation(() => {
      if (!current) {
        throw failure;
      }
    });
    let markerBeforeRollback = "";
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      markerBeforeRollback = fs.readFileSync(second.markerPath, "utf8");
      throw new Error("config changed");
    });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {
              "first-retained": first.record,
              "second-retained": second.record,
            },
            nextInstallRecords: {},
            nextConfig: {},
          }),
        ).rejects.toBe(failure);
      });
      expect(mocks.restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledOnce();
      expect(fs.existsSync(first.markerPath)).toBe(false);
      expect(markerBeforeRollback).not.toBe("");
      expect(fs.readFileSync(second.markerPath, "utf8")).toBe(markerBeforeRollback);
      expect(fs.existsSync(first.installPath)).toBe(true);
      expect(fs.existsSync(second.installPath)).toBe(true);
    } finally {
      rmSpy.mockRestore();
      mocks.lease.assertOwned.mockReset();
    }
  });

  it("fences marker restoration after rollback directory preparation loses authority", async () => {
    const stateDir = retentionTempDirs.make("openclaw-record-marker-restore-fence-");
    const fixture = createRetainedMarkerFixture(stateDir);
    await markRetainedManagedNpmInstall({
      packageDir: fixture.installPath,
      pluginId: "retained-fence",
      reason: "retained-package",
    });
    const failure = new Error("update authority revoked during marker restoration");
    let current = true;
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (target, options) => {
      const result = await mkdir(target, options);
      if (String(target) === path.dirname(fixture.markerPath)) {
        current = false;
      }
      return result;
    });
    mocks.lease.assertOwned.mockImplementation(() => {
      if (!current) {
        throw failure;
      }
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {},
            nextInstallRecords: { "retained-fence": fixture.record },
            nextConfig: {},
          }),
        ).rejects.toBe(failure);
      });
      expect(current).toBe(false);
      expect(mocks.restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledOnce();
      expect(fs.existsSync(fixture.markerPath)).toBe(false);
      expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(true);
      expect(fs.existsSync(fixture.installPath)).toBe(true);
    } finally {
      mkdirSpy.mockRestore();
      mocks.lease.assertOwned.mockReset();
    }
  });
});
