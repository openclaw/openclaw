import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  seedInstalledPluginIndex,
} from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

function managedPlugin(stateDir: string, pluginId: string) {
  const packageName = `@openclaw/${pluginId}`;
  const installPath = writeManagedNpmPlugin({ stateDir, packageName, pluginId, version: "1.0.0" });
  const record: PluginInstallRecord = { source: "npm", spec: `${packageName}@1.0.0`, installPath };
  return { installPath, records: { [pluginId]: record } };
}

const readRecords = (env: NodeJS.ProcessEnv) =>
  readPersistedInstalledPluginIndexInstallRecordsAsync({ env });

const recoveredIds = (stateDir: string) =>
  listRecoveredManagedNpmInstallCandidates({ stateDir }).map((candidate) => candidate.pluginId);
const readRow = (env: NodeJS.ProcessEnv) => readPersistedInstalledPluginIndexRowSync({ env });
const config = { plugins: { enabled: false } };
const nextConfig = { ...config, gateway: { port: 18792 } };

describe("retained managed npm record commits", () => {
  it("defers native receipts until install rollback has restored its index and markers", async () => {
    await withOpenClawTestState({ label: "native-receipt-install-rollback" }, async (state) => {
      await state.writeConfig(config);
      const records: Record<string, PluginInstallRecord> = {};
      for (const pluginId of ["unchanged", "removed"]) {
        Object.assign(records, managedPlugin(state.stateDir, pluginId).records);
      }
      await seedInstalledPluginIndex(records, { config, env: state.env });
      const initial = await readPersistedInstalledPluginIndex({ env: state.env });
      const unchanged = initial?.plugins.find((plugin) => plugin.pluginId === "unchanged");
      if (!unchanged) {
        throw new Error("Expected the unchanged installed plugin");
      }
      const removedPath = records.removed!.installPath!;
      const configBefore = fs.readFileSync(state.configPath, "utf8");
      const publication = {
        pluginId: unchanged.pluginId,
        rootDir: unchanged.rootDir,
        installRecordHash: unchanged.installRecordHash,
        key: unchanged.rootDir,
        receipt: {
          signature: "native-receipt",
          sourceDigest: "a".repeat(64),
          nativeArtifacts: {},
          nativeNamespaces: {},
        },
      };
      const publish = createPluginSourceAdmissionPublisher({ env: state.env })!;
      const failure = new Error("config commit failed after plugin retirement");
      let published: boolean | undefined;
      let publicationRewroteIndex: boolean | undefined;
      await expect(
        commitPluginInstallRecordsWithConfig({
          previousInstallRecords: records,
          nextInstallRecords: { unchanged: records.unchanged! },
          nextConfig,
          writeOptions: {
            beforeCommit: async () => {
              expect(hasRetainedManagedNpmInstallMarker(removedPath)).toBe(true);
              const before = readRow(state.env);
              published = await publish(publication);
              publicationRewroteIndex = readRow(state.env)?.value_json !== before?.value_json;
              throw failure;
            },
          },
        }),
      ).rejects.toBe(failure);
      expect(await readPersistedInstalledPluginIndex({ env: state.env })).toEqual(initial);
      expect(await readRecords(state.env)).toEqual(records);
      expect(hasRetainedManagedNpmInstallMarker(removedPath)).toBe(false);
      expect(recoveredIds(state.stateDir)).toContain("removed");
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
      expect(published).toBe(false);
      expect(publicationRewroteIndex).toBe(false);

      expect(await publish(publication)).toBe(true);
      expect(JSON.parse(readRow(state.env)!.value_json).index.plugins).toContainEqual({
        ...unchanged,
        sourceAdmissions: { [publication.key]: publication.receipt },
      });
    });
  });

  it("does not compensate after a transient lease read failure following marker removal", async () => {
    await withOpenClawTestState({ label: "retained-marker-read-refusal" }, async (state) => {
      await state.writeConfig(config);
      const { installPath, records } = managedPlugin(state.stateDir, "retained-read-refusal");
      await seedInstalledPluginIndex({}, { config, env: state.env });
      await markRetainedManagedNpmInstall({
        packageDir: installPath,
        pluginId: "retained-read-refusal",
        reason: "retained-package",
      });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(installPath);
      const markerDir = path.dirname(markerPath);
      const { dev, ino } = fs.statSync(markerDir, { bigint: true });
      const configBefore = fs.readFileSync(state.configPath, "utf8");
      const previousRow = readRow(state.env);
      let tentativeRow: ReturnType<typeof readRow>;
      const readFailure = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const leaseFailure = { code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED", cause: readFailure };
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
          tentativeRow = readRow(state.env);
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
              nextConfig,
            }),
          ).rejects.toMatchObject(leaseFailure);
          expect(failedReads).toBe(1);
          expect(lease.signal.aborted).toBe(false);
          expect(() => lease.assertOwned()).toThrowError(expect.objectContaining(leaseFailure));
          expect(tentativeRow).toBeDefined();
          expect(tentativeRow).not.toEqual(previousRow);
          expect(readRow(state.env)).toEqual(tentativeRow);
          expect(await readRecords(state.env)).toEqual(records);
          expect(fs.existsSync(markerPath)).toBe(false);
          expect(fs.statSync(markerDir, { bigint: true })).toMatchObject({ dev, ino });
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
        });
      } finally {
        rmSpy.mockRestore();
        readSpy.mockRestore();
      }

      await commitPluginInstallRecordsWithConfig({
        nextInstallRecords: records,
        nextConfig,
      });
      expect(await readRecords(state.env)).toEqual(records);
      expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject({
        gateway: { port: 18792 },
      });
      expect(fs.existsSync(installPath)).toBe(true);
    });
  });

  it.each([true, false])(
    "retires npm-to-local source changes unless symlinked: %s",
    async (symlink) => {
      await withOpenClawTestState({ label: "retained-source-change" }, async (state) => {
        const { installPath, records } = managedPlugin(state.stateDir, "retained-active");
        const activePath = state.statePath(symlink ? "active" : "extensions", "retained-active");
        fs.mkdirSync(path.dirname(activePath), { recursive: true });
        if (symlink) {
          fs.symlinkSync(installPath, activePath, "dir");
        } else {
          fs.mkdirSync(activePath);
        }
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: records,
          nextInstallRecords: {
            "retained-active": {
              source: "path",
              sourcePath: activePath,
              installPath: activePath,
            },
          },
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(!symlink);
        expect(fs.existsSync(activePath)).toBe(true);
        if (!symlink) {
          expect(recoveredIds(state.stateDir)).not.toContain("retained-active");
          await expect(
            cleanupRetainedManagedNpmInstallGenerations({ activeInstallPaths: [activePath] }),
          ).resolves.toBe(1);
          expect(fs.existsSync(installPath)).toBe(false);
          expect(fs.existsSync(activePath)).toBe(true);
        }
      });
    },
  );

  it("does not retire a removed npm record outside the managed npm root", async () => {
    await withOpenClawTestState({ label: "retained-outside-root" }, async (state) => {
      const { installPath, records } = managedPlugin(
        state.path("outside-root"),
        "outside-retained",
      );
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: records,
        nextInstallRecords: {},
        nextConfig: {},
      });
      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
    });
  });
});
