import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner-errors.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { resolveGatewayStartupFailureExitCode } from "./startup-maintenance.js";
import { prepareSystemdGatewayActivation } from "./systemd-activation.js";

const clock = vi.hoisted(() => ({ nowMs: 0 }));
const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  preflight: vi.fn(),
  fullRepair: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    clock.nowMs += ms;
  },
}));
// mock-isolation: activation owns the outcome; Doctor and state are exercised natively.
vi.mock("../../commands/doctor-database-preflight.js", () => ({
  prepareDoctorDatabasePreflight: mocks.preflight,
}));
// mock-isolation: activation owns the outcome; Doctor and state are exercised natively.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: mocks.begin,
}));
// mock-isolation: activation owns the outcome; Doctor and state are exercised natively.
vi.mock("../../commands/doctor-schema-migrations.js", () => ({
  prepareDoctorDatabaseMigrations: async () => ({ changes: [], warnings: [] }),
}));
// mock-isolation: activation owns the outcome; Doctor and state are exercised natively.
vi.mock("../../state/openclaw-state-db.js", () => ({
  prepareOpenClawStateDatabaseSchema: mocks.fullRepair,
}));
// mock-isolation: activation owns the outcome; Doctor and state are exercised natively.
vi.mock("../run-main-service-installation.js", () => ({
  readOwnGatewayServiceCommand: async () => ({ programArguments: ["openclaw"] }),
}));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const activate = () =>
  prepareSystemdGatewayActivation({ runtime, beforeStatePreparation: async () => true });
const contention = () =>
  new DoctorMaintenanceRefusalError(
    "Doctor could not enter maintenance.",
    { kind: "deferred", reason: "coordinator-contention" },
    { cause: new GatewayStateOwnerContentionError("/synthetic/openclaw.sqlite") },
  );
const owner = (run = vi.fn(async () => undefined)) => ({ run, release: vi.fn(async () => {}) });

describe("prepareSystemdGatewayActivation", () => {
  beforeEach(() => {
    clock.nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock.nowMs);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "openclaw");
    vi.stubEnv("OPENCLAW_SERVICE_KIND", "gateway");
    mocks.begin.mockReset();
    mocks.preflight.mockReset();
    mocks.preflight.mockResolvedValue({
      indeterminate: [],
      pendingMigrations: [{ path: "/synthetic/agent.sqlite" }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("waits for a transient state holder, then enters maintenance", async () => {
    const acquired = owner();
    mocks.begin.mockRejectedValueOnce(contention()).mockResolvedValueOnce(acquired);

    await activate();

    expect(mocks.begin).toHaveBeenCalledTimes(2);
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ waitForMaintenance: true }));
    expect(acquired.run).toHaveBeenCalledOnce();
    expect(acquired.release).toHaveBeenCalledOnce();
  });

  it("leaves persistent contention retryable instead of parking the unit", async () => {
    mocks.begin.mockImplementation(async () => {
      throw contention();
    });

    const failure = await activate().catch((error: unknown) => error);

    expect(clock.nowMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(findStartupMaintenanceRequiredError(failure)).toBeUndefined();
    expect(resolveGatewayStartupFailureExitCode(failure)).toBe(1);
  });

  it("does not repeat repair in-process when a reader blocks the migration", async () => {
    const acquired = owner(
      vi.fn(async () => {
        // prepareDoctorDatabaseMigrations reports repair warnings as a plain Error with this cause.
        throw new Error("Failed migrating shared state database schema", {
          cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
        });
      }),
    );
    mocks.begin.mockResolvedValue(acquired);

    const failure = await activate().catch((error: unknown) => error);

    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(acquired.release).toHaveBeenCalledOnce();
    expect(resolveGatewayStartupFailureExitCode(failure)).toBe(1);
  });

  it("treats a full repair blocked by a reader as retryable", async () => {
    mocks.fullRepair.mockResolvedValue({
      changes: [],
      warnings: ["Failed migrating shared state database schema"],
      failure: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    });
    const release = vi.fn(async () => {});
    mocks.begin.mockResolvedValue({
      run: async (operation: () => Promise<void>) => await operation(),
      release,
    });

    const failure = await activate().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
    expect(release).toHaveBeenCalledOnce();
    expect(resolveGatewayStartupFailureExitCode(failure)).toBe(1);
  });

  it.each([
    ["a failed repair", new Error("synthetic migration failure")],
    [
      "contention behind data at risk",
      new DoctorMaintenanceRefusalError(
        "Doctor could not enter maintenance.",
        { kind: "data-at-risk", reason: "gateway-state-unverified" },
        { cause: new GatewayStateOwnerContentionError("/synthetic/openclaw.sqlite") },
      ),
    ],
  ])("parks the unit after %s", async (_name, error) => {
    mocks.begin.mockRejectedValue(error);

    const failure = await activate().catch((caught: unknown) => caught);

    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(findStartupMaintenanceRequiredError(failure)?.kind).toBe("state-migrations");
    expect(resolveGatewayStartupFailureExitCode(failure)).toBe(78);
  });
});
