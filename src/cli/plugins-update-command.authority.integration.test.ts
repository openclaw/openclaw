import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as packageDir from "../infra/install-package-dir.js";
import * as installTx from "../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords } from "../plugins/installed-plugin-index-records.js";
import * as retention from "../plugins/managed-npm-retention.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  readPersistedInstalledPluginIndexRowSync as readIndexRow,
  seedInstalledPluginIndex,
} from "../plugins/test-helpers/installed-plugin-index.js";
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
const readText = (target: string) => fs.readFileSync(target, "utf8");
const readPackage = (target: string) => readText(path.join(target, "package.json"));

it.each([false, true])(
  "preserves package/index agreement after marker handling (refusal=%s)",
  (refuse) =>
    withOpenClawTestState({ label: "plugin-update-metadata-refusal" }, async (state) => {
      const pluginId = "metadata-refusal";
      const packageName = "@acme/metadata-refusal";
      const config = { plugins: { enabled: false } };
      await state.writeConfig(config);
      const writePlugin = (stateDir: string, version: string) =>
        writeManagedNpmPlugin({ stateDir, packageName, pluginId, version });
      const oldPath = writePlugin(state.stateDir, "1.0.0");
      const sourcePath = writePlugin(state.path("download"), "2.0.0");
      const sourceRoot = path.dirname(path.dirname(path.dirname(sourcePath)));
      const nextRoot = state.statePath("npm", "projects", "metadata-refusal-next");
      const nextPath = path.join(nextRoot, "node_modules", ...packageName.split("/"));
      const packageInstall = {
        sourceDir: sourceRoot,
        targetDir: nextRoot,
        mode: "install" as const,
        timeoutMs: 30_000,
        logger: {},
        copyErrorPrefix: "fixture package publish",
        hasDeps: false,
        depsLogMessage: "",
      };
      const recordsAt = (installPath: string, version: string) => ({
        [pluginId]: { source: "npm" as const, spec: `${packageName}@${version}`, installPath },
      });
      const nextRecords = recordsAt(nextPath, "2.0.0");
      await seedInstalledPluginIndex(recordsAt(oldPath, "1.0.0"), { config, env: state.env });
      const configBefore = readText(state.configPath);
      const oldSnapshot = { identity: identity(oldPath), bytes: readPackage(oldPath) };
      let nextIdentity: ReturnType<typeof identity> | undefined;
      let assertOriginal: (() => void) | undefined;
      const markerPath = retention.resolveRetainedManagedNpmInstallMarkerPath(nextPath);
      let tentativeRow: ReturnType<typeof readIndexRow>;
      let failedReads = 0;
      const readFailure = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const rm = fs.promises.rm.bind(fs.promises);
      vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        await rm(target, options);
        if (target === markerPath) {
          tentativeRow = readIndexRow({ env: state.env });
          if (refuse) {
            vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementationOnce(() => {
              failedReads++;
              throw readFailure;
            });
          }
        }
      });
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`unexpected CLI exit ${code}`);
      });
      vi.mocked(updateNpmInstalledPlugins).mockImplementation(async (params) =>
        installTx.withPluginInstallTransactions(
          params,
          { assertCurrent() {}, assertOwned() {} },
          async (owned, assertCurrent) => {
            assertOriginal = assertCurrent;
            const installed = await packageDir.installPackageDir(
              packageDir.requestDeferredPackageDirInstall(packageInstall, assertCurrent),
            );
            const transaction =
              installed.ok && packageDir.resolvePackageDirInstallTransaction(installed);
            if (!transaction) {
              throw new Error(
                installed.ok ? "expected real retained directory transaction" : installed.error,
              );
            }
            installTx.retainPluginInstallTransaction(
              owned,
              installTx.attachPluginInstallTransaction({}, transaction),
            );
            nextIdentity = identity(nextPath);
            await retention.markRetainedManagedNpmInstall({
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
        expect(tentativeRow).toBeDefined();
        expect(readIndexRow({ env: state.env })).toEqual(tentativeRow);
      } else {
        await expect(command).resolves.toBeUndefined();
      }
      expect(failedReads).toBe(refuse ? 1 : 0);
      expect(await readRecords({ env: state.env })).toEqual(nextRecords);
      expect(identity(nextPath)).toEqual(nextIdentity);
      expect(JSON.parse(readPackage(nextPath)).version).toBe("2.0.0");
      expect({ identity: identity(oldPath), bytes: readPackage(oldPath) }).toEqual(oldSnapshot);
      expect(readText(state.configPath)).toBe(configBefore);
      expect(fs.existsSync(markerPath)).toBe(false);
      await withPluginLifecycleLease({ env: state.env }, async (fresh) => {
        fresh.assertOwned();
        expect(assertOriginal).toThrow();
      });
    }),
);
