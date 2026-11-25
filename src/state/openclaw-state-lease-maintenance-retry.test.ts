import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertPersistedStateDatabaseAccessAllowed,
  StateDatabaseAdmissionPendingError,
  StateDatabaseMaintenanceScopeError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-record.js";
import { releaseOpenClawStateLeaseBestEffort } from "./openclaw-state-lease-storage.js";

const clock = vi.hoisted(() => ({ elapsed: 0 }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async (delay: number) => void (clock.elapsed += delay),
}));

beforeEach(() => {
  clock.elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock.elapsed);
});
afterEach(() => vi.restoreAllMocks());

const params = {
  scope: "core:plugin-lifecycle",
  key: "global",
  owner: "synthetic-owner",
  leaseLabel: "plugin lifecycle lease",
  operationLabel: "plugins.lifecycle.lease",
  database: { scope: "shared" as const },
};
const databasePath = "/synthetic-state/openclaw.sqlite";
const pending = new StateDatabaseAdmissionPendingError(databasePath, "admission pending");
const maintenance = new StateDatabaseOfflineMaintenanceError(databasePath, "offline maintenance");

function ownershipRefusal() {
  const ownerPath = path.join(tempDirs.make("state-lease-refusal-"), "owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: 0, createdAt: "x", configPath: "x" }));
  let failure: unknown;
  try {
    assertPersistedStateDatabaseAccessAllowed({ databasePath, ownerPath, assertMaintenance() {} });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ name: "StateDatabaseAccessError" });
  return failure;
}

it.each([
  [pending, "once"],
  [maintenance, "once"],
  [new AggregateError([pending, maintenance]), "once"],
  [maintenance, "exhaust"],
  [new StateDatabaseMaintenanceScopeError(databasePath), "never"],
  [new AggregateError([maintenance, new Error("cleanup failure")]), "never"],
  [ownershipRefusal, "never"],
] as const)("releases or retains %s with %s retry policy", async (sample, mode) => {
  const failure = typeof sample === "function" ? sample() : sample;
  let released = false;
  const operation = releaseOpenClawStateLeaseBestEffort(params, async () => {
    if (mode !== "once" || clock.elapsed === 0) {
      throw failure;
    }
    released = true;
  });
  if (mode === "once") {
    await operation;
    expect(released).toBe(true);
    expect(clock.elapsed).toBeGreaterThan(0);
    expect(clock.elapsed).toBeLessThanOrEqual(2_000);
  } else {
    await expect(operation).rejects.toBe(failure);
    expect(clock.elapsed).toBe(mode === "exhaust" ? 2_000 : 0);
  }
});
