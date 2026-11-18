import { expect, it, vi } from "vitest";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import * as lifecycle from "../state/openclaw-state-db-async-lifecycle.js";
import { isOpenClawStateDatabaseOpen } from "../state/openclaw-state-db-cache.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import {
  beginDoctorRepair,
  setupDoctorAdmissionFixture,
} from "./doctor-maintenance.admission.test-support.js";

const fixture = setupDoctorAdmissionFixture();

it("hashes unchanged state once across cold Doctor admission guards without a scope", () => {
  const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
  using context = fixture();
  expect(lifecycle.getOpenClawDatabaseMaintenanceScope()).toBeUndefined();
  expect(isOpenClawStateDatabaseOpen(context.database)).toBe(false);
  const other = resolveDoctorUpdateAdmission(context.env);
  for (let guard = 0; guard < 3; guard++) {
    context.admission();
    other.assertCurrent();
  }
  expect(hashes.mock.calls.filter(([pathname]) => pathname === context.database)).toHaveLength(1);
});

it("shares unchanged hashes across Doctor's real maintenance owner and repair scopes", async () => {
  const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
  using context = fixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", context.env.OPENCLAW_STATE_DIR);
  const scopes = vi.spyOn(lifecycle, "createOpenClawDatabaseMaintenanceScope");
  const maintenance = await beginDoctorRepair({
    assertCurrent: context.admission,
    beforeStateMutation: async () => {
      // gateway-lock and doctor-maintenance-state create distinct scopes.
      // Use their real custody and run methods before backup admits live reads.
      expect(isOpenClawStateDatabaseOpen(context.database)).toBe(false);
      expect(scopes.mock.results).toHaveLength(2);
      for (let guard = 0; guard < 3; guard++) {
        for (const result of scopes.mock.results) {
          if (result.type !== "return") {
            throw new Error("Doctor maintenance scope creation failed");
          }
          result.value.run(context.admission);
        }
      }
      expect(hashes.mock.calls.filter(([pathname]) => pathname === context.database)).toHaveLength(
        1,
      );
    },
  });
  try {
    expect(maintenance).toBeDefined();
  } finally {
    await maintenance?.release();
  }
});
