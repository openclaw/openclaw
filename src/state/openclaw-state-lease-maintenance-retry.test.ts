import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  StateDatabaseAccessError,
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-record.js";
import { releaseOpenClawStateLeaseBestEffort } from "./openclaw-state-lease-storage.js";

const clock = vi.hoisted(() => ({ elapsed: 0 }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async (delay: number) => {
    clock.elapsed += delay;
  },
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
const pending = new StateDatabaseAdmissionPendingError(databasePath, "Synthetic admission pending");
const maintenance = new StateDatabaseOfflineMaintenanceError(
  databasePath,
  "Synthetic offline maintenance",
);

it.each([pending, maintenance, new AggregateError([pending, maintenance])])(
  "releases the original lease after temporary maintenance contention (%s)",
  async (failure) => {
    let held = true;
    await releaseOpenClawStateLeaseBestEffort(params, async () => {
      if (clock.elapsed === 0) {
        throw failure;
      }
      held = false;
    });
    expect(held).toBe(false);
    expect(clock.elapsed).toBeGreaterThan(0);
    expect(clock.elapsed).toBeLessThanOrEqual(2_000);
  },
);

it("retains the maintenance error when release exhausts its existing two-second budget", async () => {
  await expect(
    releaseOpenClawStateLeaseBestEffort(params, async () => {
      throw maintenance;
    }),
  ).rejects.toBe(maintenance);
  expect(clock.elapsed).toBe(2_000);
});

it.each([
  new StateDatabaseAccessError("Synthetic ownership cannot be verified"),
  new AggregateError([maintenance, new Error("Synthetic cleanup failure")]),
])("does not retry an unclassified release failure (%s)", async (failure) => {
  await expect(
    releaseOpenClawStateLeaseBestEffort(params, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(clock.elapsed).toBe(0);
});
