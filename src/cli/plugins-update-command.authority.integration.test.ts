import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import {
  attachPluginInstallTransaction,
  retainPluginInstallTransaction,
  withPluginInstallTransactions,
} from "../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/installed-plugin-index-record-state.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "../plugins/managed-npm-retention.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

vi.mock("../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/update.js")>()),
  updateNpmInstalledPlugins: vi.fn(),
}));
vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: async () => null,
}));
afterEach(() => vi.restoreAllMocks());

function identity(target: string) {
  const stat = fs.statSync(target, { bigint: true });
  return [stat.dev, stat.ino];
}

describe("plugin update metadata refusal and retained package settlement", () => {
  it.each([false, true])(
    "preserves package/index agreement after marker handling (refusal=%s)",
    async (refuse) => {
      await withOpenClawTestState({ label: "plugin-update-metadata-refusal" }, async (state) => {
        const pluginId = "metadata-refusal";
        const packageName = "@acme/metadata-refusal";
        const config = { plugins: { enabled: false } };
        await state.writeConfig(config);
        const oldPath = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName,
          pluginId,
          version: "1.0.0",
        });
        const sourcePath = writeManagedNpmPlugin({
          stateDir: state.path("download"),
          packageName,
          pluginId,
          version: "2.0.0",
        });
        const sourceRoot = path.dirname(path.dirname(path.dirname(sourcePath)));
        const nextRoot = state.statePath("npm", "projects", "metadata-refusal-next");
        const nextPath = path.join(nextRoot, "node_modules", ...packageName.split("/"));
        const records = {
          [pluginId]: {
            source: "npm" as const,
            spec: `${packageName}@1.0.0`,
            installPath: oldPath,
          },
        };
        const nextRecords = {
          [pluginId]: {
            source: "npm" as const,
            spec: `${packageName}@2.0.0`,
            installPath: nextPath,
          },
        };
        await seedInstalledPluginIndex(records, { config, env: state.env });
        const configBefore = fs.readFileSync(state.configPath, "utf8");
        const oldIdentity = identity(oldPath);
        const oldBytes = fs.readFileSync(path.join(oldPath, "package.json"), "utf8");
        let nextIdentity: ReturnType<typeof identity> | undefined;
        let assertOriginal: (() => void) | undefined;
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(nextPath);
        let tentativeRow: ReturnType<typeof readPersistedInstalledPluginIndexRowSync>;
        let failNextRead = false;
        let failedReads = 0;
        const readFailure = Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
        const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
        vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
          if (failNextRead) {
            failNextRead = false;
            failedReads++;
            throw readFailure;
          }
          return readExpiry(...args);
        });
        const rm = fs.promises.rm.bind(fs.promises);
        vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          if (target === markerPath) {
            tentativeRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
            failNextRead = refuse;
          }
        });
        vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new Error(`unexpected CLI exit ${code}`);
        });
        vi.mocked(updateNpmInstalledPlugins).mockImplementation(async (params) =>
          withPluginInstallTransactions(
            params,
            () => {},
            async (owned, assertCurrent) => {
              assertOriginal = assertCurrent;
              const installed = await installPackageDir(
                requestDeferredPackageDirInstall(
                  {
                    sourceDir: sourceRoot,
                    targetDir: nextRoot,
                    mode: "install",
                    timeoutMs: 30_000,
                    logger: {},
                    copyErrorPrefix: "fixture package publish",
                    hasDeps: false,
                    depsLogMessage: "",
                  },
                  assertCurrent,
                ),
              );
              if (!installed.ok) {
                throw new Error(installed.error);
              }
              const transaction = resolvePackageDirInstallTransaction(installed);
              if (!transaction) {
                throw new Error("expected real retained directory transaction");
              }
              retainPluginInstallTransaction(
                owned,
                attachPluginInstallTransaction({}, transaction),
              );
              nextIdentity = identity(nextPath);
              await markRetainedManagedNpmInstall({
                packageDir: nextPath,
                pluginId,
                reason: "retained-package",
              });
              return {
                config: {
                  ...params.config,
                  plugins: { ...params.config.plugins, installs: nextRecords },
                },
                changed: true,
                outcomes: [{ pluginId, status: "updated", message: "fixture package updated" }],
              };
            },
          ),
        );
        const command = runPluginUpdateCommand({ ids: [pluginId], opts: {} });
        if (refuse) {
          await expect(command).rejects.toThrow();
          expect(failedReads).toBe(1);
          expect(tentativeRow).toBeDefined();
          expect(readPersistedInstalledPluginIndexRowSync({ env: state.env })).toEqual(
            tentativeRow,
          );
        } else {
          await expect(command).resolves.toBeUndefined();
          expect(failedReads).toBe(0);
        }
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          nextRecords,
        );
        expect(
          fs.existsSync(nextPath),
          "the retained inventory must not point at a rolled-back package",
        ).toBe(true);
        expect(identity(nextPath)).toEqual(nextIdentity);
        expect(
          JSON.parse(fs.readFileSync(path.join(nextPath, "package.json"), "utf8")).version,
        ).toBe("2.0.0");
        expect(identity(oldPath)).toEqual(oldIdentity);
        expect(fs.readFileSync(path.join(oldPath, "package.json"), "utf8")).toBe(oldBytes);
        expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
        expect(fs.existsSync(markerPath)).toBe(false);
        if (!assertOriginal) {
          throw new Error("update did not capture real package authority");
        }
        const original = assertOriginal;
        await withPluginLifecycleLease({ env: state.env }, async (fresh) => {
          fresh.assertOwned();
          expect(original).toThrow();
        });
      });
    },
  );
});
