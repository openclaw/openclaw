import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandFailureResult } from "../cli/update-cli/update-command-result.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { readActiveGatewayLockIdentity, resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { classifyDoctorMaintenanceRefusal } from "./doctor-maintenance-inspection.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function updateFailure(cause: unknown) {
  return createUpdateCommandFailureResult({
    mode: "npm",
    root: "/synthetic/openclaw",
    durationMs: 1,
    recovery: { serviceRestartSafe: true, version: "2026.11.5" },
    failure: { cause },
  });
}

it("defers a Gateway lock that cannot be inspected instead of marking data at risk", async () => {
  const stateDir = dirs.make("doctor-lock-inspection-");
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json` };
  // An unreadable lock record: ownership cannot be verified, and nothing was written.
  const { ownerLockPath } = resolveGatewayLockPaths(env);
  fs.mkdirSync(ownerLockPath, { recursive: true });
  const error = await readActiveGatewayLockIdentity({ env, requireInspection: true }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ name: "GatewayLockError" });
  expect(classifyDoctorMaintenanceRefusal(error)).toEqual({
    kind: "deferred",
    reason: "admission-unavailable",
  });
  // The update keeps the recovery it had; it does not name a data risk.
  expect(updateFailure(error).recovery).toEqual({
    serviceRestartSafe: true,
    version: "2026.11.5",
  });
});

it("keeps a lock owner from another process namespace at risk", async () => {
  const stateDir = dirs.make("doctor-lock-namespace-");
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json` };
  // A live-looking owner whose process namespace cannot be compared with ours.
  const { ownerLockPath, configPath } = resolveGatewayLockPaths(env);
  fs.mkdirSync(path.dirname(ownerLockPath), { recursive: true });
  fs.writeFileSync(
    ownerLockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      role: "gateway",
      createdAt: new Date().toISOString(),
      configPath,
      startTime: 1,
      processNamespace: null,
    }),
  );
  const error = await readActiveGatewayLockIdentity({ env, requireInspection: true }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ name: "GatewayLockError" });
  expect(classifyDoctorMaintenanceRefusal(error)).toEqual({
    kind: "data-at-risk",
    reason: "gateway-state-unverified",
  });
});

it("keeps an unrestored partial config publication at risk", () => {
  const error = new ConfigWritePostCommitError({
    configPath: path.join("/synthetic", "openclaw.json"),
    rollbackStatus: "not-restored",
    publication: "partial",
    cause: new Error("rename failed after the first include was published"),
  });
  expect(classifyDoctorMaintenanceRefusal(error)).toEqual({
    kind: "data-at-risk",
    reason: "gateway-state-unverified",
  });
  expect(updateFailure(error).recovery).toEqual({
    serviceRestartSafe: false,
    reason: "runtime-verification-failed",
    dataAtRisk: "gateway-state-unverified",
  });
});
