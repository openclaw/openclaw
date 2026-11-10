import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openClientCredentialCustody } from "../../infra/client-credential-store.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fingerprints chat sends with the cached identity while state and credential stores are busy", async () => {
  const stateDir = tempDirs.make("openclaw-chat-identity-contention-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const request = { sessionKey: "agent:test:main", message: "hello" };
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  let expected: string;
  try {
    expected = await fingerprintSessionGoalRequest(request);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
  await closeOpenClawStateDatabaseAsync();

  // Hold maintenance custody without borrowing its database access scope.
  const blocker = acquireGatewayStateOwner({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
  });
  try {
    using credentials = openClientCredentialCustody(process.env);
    expect(credentials).toBeDefined();
    expect(() => loadOrCreateDeviceIdentity()).toThrow("Client credential owner is busy");
    expect(() => openOpenClawStateDatabase()).toThrow(
      "without an active schema lease or maintenance scope",
    );
    expect(await fingerprintSessionGoalRequest(request)).toBe(expected);
    expect(await fingerprintSessionGoalRequest({ ...request, message: "changed" })).not.toBe(
      expected,
    );
  } finally {
    blocker.release();
  }
});
