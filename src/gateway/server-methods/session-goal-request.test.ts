import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fingerprints chat sends with the cached identity while the state database is busy", () => {
  const stateDir = tempDirs.make("openclaw-chat-identity-contention-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const request = { sessionKey: "agent:test:main", message: "hello" };
  const expected = fingerprintSessionGoalRequest(request);
  closeOpenClawStateDatabaseForTest();

  // Hold maintenance custody without borrowing its database access scope.
  const blocker = acquireGatewayStateOwner({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
  });
  try {
    expect(() => loadOrCreateDeviceIdentity()).toThrow("offline maintenance");
    expect(fingerprintSessionGoalRequest(request)).toBe(expected);
    expect(fingerprintSessionGoalRequest({ ...request, message: "changed" })).not.toBe(expected);
  } finally {
    blocker.release();
  }
});
