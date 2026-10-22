import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { captureUpdateRecoveryBaseline } from "../infra/update-recovery-baseline-capture.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { listUpdateRuns } from "../infra/update-run-reader.js";
import * as pluginResources from "../plugins/doctor-contract-registry.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db-cache.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { parseUpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import {
  beginDoctorRepair,
  setupDoctorAdmissionFixture,
} from "./doctor-maintenance.admission.test-support.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const prepareService = vi.hoisted(() => vi.fn<typeof maybeStopManagedServiceBeforeMutableUpdate>());
vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (original) => ({
  ...(await original<typeof import("../cli/update-cli/update-command-service-maintenance.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: prepareService,
}));
vi.mock("../config/paths.js", async (original) => ({
  ...(await original<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("./doctor-service-repair-policy.js", async (original) => ({
  ...(await original<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
// The process and database owners stay real; only the external supervisor is synthetic.
vi.mock("./doctor-maintenance-stale-service.js", async (original) => ({
  ...(await original<typeof import("./doctor-maintenance-stale-service.js")>()),
  inspectStaleDoctorGateway: async () => undefined,
}));

const fixture = setupDoctorAdmissionFixture();

it.each([true, false])(
  "keeps Doctor continuation with its repair scope (cached writer: %s)",
  async (keepWriter) => {
    const { env, database, family, assertIsolation } = fixture(true);
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    const run = createUpdateRun(
      { trigger: "cli", origin: { driver: readUpdateRunDriver() } },
      { env },
    );
    vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    const install = path.join(env.OPENCLAW_STATE_DIR, "install");
    fs.mkdirSync(install);
    const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
    const pluginDirectory = path.join(env.OPENCLAW_STATE_DIR, "plugin-data");
    fs.mkdirSync(pluginDirectory);
    const pluginPath = (index: number) => path.join(pluginDirectory, `${index}.txt`);
    for (let index = 0; index < 32; index++) {
      fs.writeFileSync(pluginPath(index), `plugin payload ${index}`);
    }
    // The plugin supplies its declared backup roots; traversal and admission stay real.
    vi.spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources").mockResolvedValue({
      resources: [{ path: pluginDirectory, kind: "directory" }],
      deferredPluginIds: new Set(),
      notices: [],
      assertCurrent() {},
    });
    let gateway: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined;
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    prepareService.mockImplementation(async (params) => {
      const inspected = {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: true,
        offline: false,
        servicePid: process.pid,
        serviceEnv: { ...process.env },
        serviceUpdateVerdict: {
          kind: "owned" as const,
          root: install,
          fingerprint: "synthetic-supervisor",
          refreshDefinition: false,
        },
      };
      if (params.phase === "inspect") {
        return inspected;
      }
      params.assertCurrent?.();
      await gateway!.release();
      gateway = undefined;
      if (!keepWriter) {
        await closeOpenClawStateDatabaseAsync();
      }
      const stopped = { ...inspected, stopped: true, running: false, offline: true };
      params.onStopped?.(stopped);
      return stopped;
    });
    try {
      for (let cycle = 0; cycle < (keepWriter ? 2 : 1); cycle++) {
        gateway = await acquireGatewayLock({
          env: process.env,
          role: "gateway",
          listenerMode: "supervised",
          supervisor: { kind: "launchd", name: "synthetic-supervisor" },
          port: 1,
          allowInTests: true,
        });
        maintenance = await beginDoctorRepair({
          root: install,
          beforeStateMutation: async () => {
            const original = family();
            listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission);
            if (!keepWriter) {
              expect(isOpenClawStateDatabaseOpen(database)).toBe(false);
              const scope = getOpenClawDatabaseMaintenanceScope()!;
              hashes.mockClear();
              const { ref } = await captureUpdateRecoveryBaseline({
                runId: "doctor-plugin-capture",
                installRoot: install,
                env,
                drivers: [],
                assertCurrent: scope.assertAdmission,
                acquisition: { mode: "maintenance-owner" },
              });
              expect(hashes.mock.calls.length).toBeLessThanOrEqual(2);
              const manifest = parseUpdateRecoveryBackupManifest(
                fs.readFileSync(ref.manifestPath, "utf8"),
              );
              for (let index = 0; index < 32; index++) {
                const captured = manifest.entries.find(
                  (entry) => entry.sourcePath === pluginPath(index),
                );
                if (captured?.kind !== "file") {
                  throw new Error(`Missing captured plugin file ${index}`);
                }
                expect(
                  fs.readFileSync(path.join(ref.directory, captured.archivePath), "utf8"),
                ).toBe(`plugin payload ${index}`);
              }
            }
            expect(family()).toEqual(original);
          },
        });
        hashes.mockClear();
        maintenance!.run(() => listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission));
        maintenance!.run(() => listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission));
        expect(hashes).not.toHaveBeenCalled();
        await maintenance!.release();
        maintenance = undefined;
        hashes.mockClear();
        // Released custody no longer lends its warm reader to a later cold inspection.
        resolveDoctorUpdateAdmission(env, run.runId).assertCurrent();
        expect(hashes).toHaveBeenCalled();
      }
    } finally {
      await maintenance?.release();
      await gateway?.release();
      assertIsolation();
    }
  },
);
