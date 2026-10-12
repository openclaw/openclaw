import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { listUpdateRuns } from "../infra/update-run-reader.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const service = vi.hoisted(() => ({
  prepare: vi.fn<typeof maybeStopManagedServiceBeforeMutableUpdate>(),
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (original) => ({
  ...(await original<typeof import("../cli/update-cli/update-command-service-maintenance.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: service.prepare,
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
    const { env, family, assertIsolation } = fixture(true);
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    const install = path.join(env.OPENCLAW_STATE_DIR, "install");
    fs.mkdirSync(install);
    const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
    let gateway: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined;
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    service.prepare.mockImplementation(async (params) => {
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
        expect(gateway).toBeDefined();
        maintenance = await beginDoctorMaintenance({
          root: install,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          beforeStateMutation: async () => {
            const original = family();
            listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission);
            expect(family()).toEqual(original);
          },
        });
        expect(maintenance).toBeDefined();
        hashes.mockClear();
        maintenance!.run(() => listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission));
        maintenance!.run(() => listUpdateRuns({}, { env }, openDoctorStateSchemaReadAdmission));
        expect(hashes).not.toHaveBeenCalled();
        await maintenance!.release();
        maintenance = undefined;
        hashes.mockClear();
        // Released custody no longer lends its warm reader to a later cold inspection.
        resolveDoctorUpdateAdmission(env).assertCurrent();
        expect(hashes).toHaveBeenCalled();
      }
    } finally {
      await maintenance?.release();
      await gateway?.release();
      assertIsolation();
    }
  },
);
