import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { resolveSqliteSchemaAssetInputs } from "../../scripts/lib/sqlite-schema-assets.mts";
import { vitestWorkerRuntimeAssets } from "../../scripts/lib/vitest-worker-declarations.mts";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { useExecutorFixture } from "../cli/update-cli/update-command-executor.test-support.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPackageVersion } from "./package-json.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import type { PluginCohortRecovery } from "./update-plugin-cohort-schema.js";
import { createUpdateRun } from "./update-run-ledger.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  loadPluginCohortRecovery,
} from "./update-run-recovery-store.js";

const fixture = useExecutorFixture("post-ready-cohort-commit-");

it.each([false, true])(
  "the real commit worker requires current native custody and the actual candidate build (wrong build=%s)",
  async (wrongBuild) => {
    const { root: installKey, control } = fixture();
    const binding = createManagedHandoffTestBinding(control);
    // The prepared generation deliberately is not an installation root. Copy its
    // actual graph and build metadata together so checkout dist cannot supply the
    // expected identity while a different compiled generation executes the guard.
    const runtimeRoot = createCompiledSdkHost(
      [
        runtimeProcessEntrypoints.updateMigratedFinalize,
        runtimeProcessEntrypoints.workerNativeLifecycle,
        runtimeProcessEntrypoints.sqliteWriterAdmission,
        runtimeProcessEntrypoints.sqliteStore,
        runtimeProcessEntrypoints.sqliteIntegrity,
        runtimeProcessEntrypoints.sqliteReadOnly,
        runtimeProcessEntrypoints.sqliteReadOnlyNativeResource,
        runtimeProcessEntrypoints.sqliteSnapshotStaging,
        runtimeProcessEntrypoints.sqliteSourceRevision,
        runtimeProcessEntrypoints.sharedStateStore,
        runtimeProcessEntrypoints.stateOwnership,
        runtimeProcessEntrypoints.stateLeaseHeartbeat,
        runtimeProcessEntrypoints.stateRead,
      ],
      (prefix) => fs.mkdtempSync(path.join(installKey, prefix)),
    );
    if (!runtimeRoot) {
      throw new Error("Commit worker fixture requires the repository's compiled worker generation");
    }
    const sourceWorker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize);
    const generationRoot = path.resolve(path.dirname(fileURLToPath(sourceWorker)), "../..");
    for (const asset of vitestWorkerRuntimeAssets) {
      fs.copyFileSync(path.join(generationRoot, asset), path.join(runtimeRoot, asset));
    }
    // The schema build owner emits lazy catalogs as asset URLs rather than
    // module imports, so the module-closure copier cannot discover these edges.
    for (const sourceAsset of resolveSqliteSchemaAssetInputs()) {
      const relative = path.join("dist", "assets", "sqlite-schema", path.basename(sourceAsset));
      const target = path.join(runtimeRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(generationRoot, relative), target);
    }
    const worker = resolveRuntimeWorkerUrl({
      ...runtimeProcessEntrypoints.updateMigratedFinalize,
      root: runtimeRoot,
    });
    const version = await readPackageVersion(runtimeRoot);
    if (!version) {
      throw new Error("Commit worker fixture has no package version");
    }
    const buildId = await readBuiltGatewayBuildId(runtimeRoot);
    if (!buildId) {
      throw new Error("Commit worker fixture has no compiled build identity");
    }
    await withOpenClawTestState(
      { label: "post-ready-cohort-commit", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const temporary = state.path("tmp");
        fs.mkdirSync(temporary, { mode: 0o1700 });
        const { runId } = createUpdateRun({ trigger: "api" }, { env: state.env });
        const reservation: UpdateRecoveryRecord = {
          runId,
          transactionId: randomUUID(),
          revision: 0,
          claimId: randomUUID(),
          claimKind: "initial",
          handoff: null,
          source: { stateDir: state.stateDir, configPath: state.configPath },
          from: {
            root: installKey,
            nodePath: process.execPath,
            version: "2026.10.8",
            buildId: "prior",
          },
          to: {
            root: runtimeRoot,
            nodePath: process.execPath,
            version,
            buildId: wrongBuild ? "unmatched-fixture-build" : buildId,
          },
          createdAtMs: 1,
          updatedAtMs: 1,
          effects: [],
          restore: null,
          verification: null,
          primaryFailure: null,
        };
        const cohort: PluginCohortRecovery = {
          runId,
          transactionId: reservation.transactionId,
          revision: 0,
          disposition: "pending",
          installKey,
          priorArtifacts: [],
          artifacts: [],
          publications: [],
          settledPublications: 0,
        };
        beginPluginCohortRecovery(reservation, cohort, { assertCurrent() {} }, { env: state.env });
        const invoke = () =>
          runUtf8CommandWithTimeout(
            [
              process.execPath,
              // Only Node needs a loader for the source-form handoff preload.
              ...(process.versions.bun ? [] : ["--import", import.meta.resolve("tsx")]),
              binding.nodeOption,
              ...resolveRuntimeWorkerArgv(worker),
              "--commit-plugin-cohort",
            ],
            {
              cwd: runtimeRoot,
              baseEnv: {},
              env: {
                ...state.env,
                TMPDIR: temporary,
                TMP: temporary,
                TEMP: temporary,
                [UPDATE_RUN_ID_ENV]: runId,
              },
              input: JSON.stringify({ runId, transactionId: cohort.transactionId, installKey }),
              timeoutMs: 30_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              maxOutputBytes: { stdout: 64 * 1024, stderr: 64 * 1024 },
            },
          );
        if (!wrongBuild) {
          await withUpdateCommandExecutor(randomUUID(), async (executor) => {
            await executor.enter(installKey);
            const blocked = await invoke();
            expect(blocked.code).not.toBe(0);
            expect(blocked.cleanup).toBe("normal");
            expect(loadPluginCohortRecovery(runId, { env: state.env })).toBeDefined();
          });
        }
        const result = await invoke();
        expect(result.cleanup).toBe("normal");
        expect(result.termination).toBe("exit");
        if (wrongBuild) {
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain("candidate version and build");
          expect(loadPluginCohortRecovery(runId, { env: state.env })?.cohort.disposition).toBe(
            "pending",
          );
        } else {
          expect(result.code, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({
            runId,
            transactionId: cohort.transactionId,
            configPaths: [],
          });
          expect(loadPluginCohortRecovery(runId, { env: state.env })).toBeUndefined();
        }
      },
    );
  },
);
