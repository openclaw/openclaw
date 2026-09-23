import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-record-state.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

function npmRecord(packageName: string, installPath: string): PluginInstallRecord {
  return { source: "npm", spec: `${packageName}@1.0.0`, installPath };
}

describe("retained managed npm record commits", () => {
  it("does not compensate after a transient lease read failure following marker removal", async () => {
    await withOpenClawTestState({ label: "retained-marker-read-refusal" }, async (state) => {
      const config = { plugins: { enabled: false } };
      await state.writeConfig(config);
      const packageName = "@openclaw/retained-read-refusal";
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName,
        pluginId: "retained-read-refusal",
        version: "1.0.0",
      });
      const records = { "retained-read-refusal": npmRecord(packageName, installPath) };
      await seedInstalledPluginIndex({}, { config, env: state.env });
      await markRetainedManagedNpmInstall({
        packageDir: installPath,
        pluginId: "retained-read-refusal",
        reason: "retained-package",
      });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(installPath);
      const markerDir = path.dirname(markerPath);
      const directoryBefore = fs.statSync(markerDir, { bigint: true });
      const configBefore = fs.readFileSync(state.configPath, "utf8");
      const previousRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
      let tentativeRow: ReturnType<typeof readPersistedInstalledPluginIndexRowSync>;
      const readFailure = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
      let failNextRead = false;
      let failedReads = 0;
      const readSpy = vi
        .spyOn(leaseStore, "readOpenClawStateLeaseExpiry")
        .mockImplementation((...args) => {
          if (failNextRead) {
            failNextRead = false;
            failedReads += 1;
            throw readFailure;
          }
          return readExpiry(...args);
        });
      const rm = fs.promises.rm.bind(fs.promises);
      const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        await rm(target, options);
        if (target === markerPath) {
          tentativeRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
          // Fail the next real lease verification after removal, before its caller records progress.
          failNextRead = true;
        }
      });
      try {
        await withPluginLifecycleLease({ env: state.env }, async (lease) => {
          await expect(
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords: {},
              nextInstallRecords: records,
              nextConfig: { ...config, gateway: { port: 18792 } },
            }),
          ).rejects.toMatchObject({
            code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
            cause: readFailure,
          });
          expect(failedReads).toBe(1);
          expect(lease.signal.aborted).toBe(false);
          expect(() => lease.assertOwned()).toThrowError(
            expect.objectContaining({
              code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
              cause: readFailure,
            }),
          );
          expect(tentativeRow).toBeDefined();
          expect(tentativeRow).not.toEqual(previousRow);
          expect(readPersistedInstalledPluginIndexRowSync({ env: state.env })).toEqual(
            tentativeRow,
          );
          expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
            records,
          );
          expect(fs.existsSync(markerPath)).toBe(false);
          const directoryAfter = fs.statSync(markerDir, { bigint: true });
          expect([directoryAfter.dev, directoryAfter.ino]).toEqual([
            directoryBefore.dev,
            directoryBefore.ino,
          ]);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
        });
      } finally {
        rmSpy.mockRestore();
        readSpy.mockRestore();
      }

      await commitPluginInstallRecordsWithConfig({
        nextInstallRecords: records,
        nextConfig: { ...config, gateway: { port: 18792 } },
      });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(records);
      expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject({
        gateway: { port: 18792 },
      });
      expect(fs.existsSync(installPath)).toBe(true);
    });
  });

  it("suppresses recovery when a retained install record is removed", async () => {
    await withOpenClawTestState({ label: "retained-record-removal" }, async (state) => {
      const packageName = "@openclaw/retained-demo";
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName,
        pluginId: "retained-demo",
        version: "1.0.0",
      });
      expect(
        listRecoveredManagedNpmInstallCandidates({ stateDir: state.stateDir }).map(
          (candidate) => candidate.pluginId,
        ),
      ).toContain("retained-demo");

      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: { "retained-demo": npmRecord(packageName, installPath) },
        nextInstallRecords: {},
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
      expect(
        listRecoveredManagedNpmInstallCandidates({ stateDir: state.stateDir }).map(
          (candidate) => candidate.pluginId,
        ),
      ).not.toContain("retained-demo");
    });
  });

  it.each(["direct", "symlink"] as const)(
    "does not retire a package still used by a %s active install path",
    async (activePathKind) => {
      await withOpenClawTestState({ label: `retained-active-${activePathKind}` }, async (state) => {
        const packageName = "@openclaw/retained-active";
        const installPath = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName,
          pluginId: "retained-active",
          version: "1.0.0",
        });
        let activePath = installPath;
        if (activePathKind === "symlink") {
          activePath = state.statePath("active", "retained-active");
          fs.mkdirSync(path.dirname(activePath), { recursive: true });
          fs.symlinkSync(installPath, activePath, "dir");
        }

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: { "retained-active": npmRecord(packageName, installPath) },
          nextInstallRecords: {
            "retained-active": {
              source: "path",
              sourcePath: activePath,
              installPath: activePath,
            },
          },
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(fs.existsSync(activePath)).toBe(true);
      });
    },
  );

  it("does not retire a removed npm record outside the managed npm root", async () => {
    await withOpenClawTestState({ label: "retained-outside-root" }, async (state) => {
      const outsideRoot = state.path("outside-root");
      try {
        const packageName = "@openclaw/outside-retained";
        const installPath = writeManagedNpmPlugin({
          stateDir: outsideRoot,
          packageName,
          pluginId: "outside-retained",
          version: "1.0.0",
        });
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: { "outside-retained": npmRecord(packageName, installPath) },
          nextInstallRecords: {},
          nextConfig: {},
        });
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("keeps npm-to-local source changes cleanup-eligible", async () => {
    await withOpenClawTestState({ label: "retained-source-change" }, async (state) => {
      const packageName = "@openclaw/moved-local";
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName,
        pluginId: "moved-local",
        version: "1.0.0",
      });
      const localInstallPath = state.statePath("extensions", "moved-local");
      fs.mkdirSync(localInstallPath, { recursive: true });

      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: { "moved-local": npmRecord(packageName, installPath) },
        nextInstallRecords: {
          "moved-local": {
            source: "path",
            sourcePath: localInstallPath,
            installPath: localInstallPath,
          },
        },
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          activeInstallPaths: [localInstallPath],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(installPath)).toBe(false);
      expect(fs.existsSync(localInstallPath)).toBe(true);
    });
  });
});
