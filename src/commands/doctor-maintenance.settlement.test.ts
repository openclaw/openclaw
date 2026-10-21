import "./doctor-maintenance.settlement.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { UpdateFinalizationLifecycle } from "../cli/update-cli/update-finalization-lifecycle.js";
import { GatewayServiceStopUnsafeError } from "../daemon/service-inspection-error.js";
import { resolveGatewayService } from "../daemon/service.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import * as updateState from "../infra/update-candidate-state.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  DoctorMaintenanceRefusalError,
  UpdateDoctorError,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { projectPublicUpdateFailureIdentifiers } from "../infra/update-failure-public-identifiers.js";
import { readUpdatePhysicalDatabaseGenerations } from "../infra/update-physical-database-generations.js";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { defaultRuntime } from "../runtime.js";
import * as databaseBackup from "../snapshot/database-backup.js";
import { OpenClawAgentDatabaseLeaseActiveError } from "../state/openclaw-agent-db-lease.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import * as nocow from "./doctor-sqlite-nocow.js";

const settlement = await import("./doctor-maintenance.settlement.test-support.js");
const { begin, boundary, cleanupBarrier, root, tempDirs } = settlement;

type BoundaryMock = Exclude<keyof typeof boundary, "scopeAssert">;

function expectCalls(count: number, ...names: BoundaryMock[]) {
  for (const name of names) {
    expect(boundary[name], name).toHaveBeenCalledTimes(count);
  }
}

function expectOrder(first: BoundaryMock, second: BoundaryMock) {
  expect(boundary[first].mock.invocationCallOrder[0]!).toBeLessThan(
    boundary[second].mock.invocationCallOrder[0]!,
  );
}

function beginWithGenerations(
  databaseGenerations?: Record<string, string | null>,
  installRoot: string | null = null,
) {
  return beginDoctorMaintenance({
    root: installRoot,
    options: { repair: true, nonInteractive: true },
    runtime: { log: boundary.log, error: vi.fn(), exit: vi.fn() },
    databaseGenerations,
  });
}

function executeEvidence(pathname: string, sql: string) {
  const db = new DatabaseSync(pathname);
  db.exec(sql);
  db.close();
}

function fingerprintReads() {
  // These SQLite fixtures exercise generation settlement without native engine inspection.
  vi.spyOn(databaseBackup, "readBackupEngine").mockReturnValue({ engine: "sqlite" });
  vi.spyOn(updateState, "readUpdateDatabaseGenerationsIsolated").mockImplementation(async (paths) =>
    readUpdatePhysicalDatabaseGenerations(paths),
  );
}

function fail(name: "readLeases" | "lease" | "gatewayAcquire" | "ownerAssert", error: Error) {
  boundary[name].mockImplementation(() => {
    throw error;
  });
}

function afterStop(effect: () => void) {
  const stop = boundary.stop.getMockImplementation()!;
  boundary.stop.mockImplementation(async (params) => {
    const result = await stop(params);
    if (params.phase !== "inspect") {
      effect();
    }
    return result;
  });
}

async function settleCleanup(
  work: Promise<unknown>,
  barrier: ReturnType<typeof cleanupBarrier>,
  cleanup: "forced" | "uncertain",
  checkPending: () => void,
) {
  try {
    await Promise.race([
      barrier.joining,
      work.then(() => {
        throw new Error("Maintenance advanced before physical cleanup joined");
      }),
    ]);
    checkPending();
  } finally {
    barrier.cleanup.resolve(cleanup);
    await work;
  }
  return await work;
}

it("refuses rollback attribution for writes preceding Doctor admission", async () => {
  fingerprintReads();
  const pathname = path.join(settlement.tempDirs.make("doctor-write-receipt-"), "agent.sqlite");
  const missing = `${pathname}.missing`;
  executeEvidence(
    pathname,
    "CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)",
  );
  const databaseGenerations = await readUpdatePhysicalDatabaseGenerations([pathname, missing]);
  executeEvidence(pathname, "INSERT INTO evidence VALUES (99)");
  const admitted = await readUpdatePhysicalDatabaseGenerations([pathname, missing]);
  const maintenance = await beginWithGenerations(databaseGenerations);
  expect(maintenance?.databaseWrites).toBeUndefined();
  await maintenance!.releaseState();
  const receipt = maintenance!.databaseWrites;
  expect(receipt).toEqual({
    unchanged: false,
    fromGenerations: admitted,
    generations: await readUpdatePhysicalDatabaseGenerations([pathname, missing]),
  });
  expect(receipt?.generations[pathname]).not.toBe(databaseGenerations[pathname]);
  executeEvidence(pathname, "INSERT INTO evidence VALUES (100)");
  await maintenance!.release();
  expect(maintenance!.databaseWrites).toEqual(receipt);
  expect((await readUpdatePhysicalDatabaseGenerations([pathname]))[pathname]).not.toBe(
    receipt?.generations[pathname],
  );
});

it("refuses automatic restore after a NOCOW physical replacement during Doctor maintenance", async () => {
  fingerprintReads();
  const pathname = path.join(settlement.tempDirs.make("doctor-nocow-receipt-"), "agent.sqlite");
  executeEvidence(
    pathname,
    "CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)",
  );
  const generations = await readUpdatePhysicalDatabaseGenerations([pathname]);
  const rewrite = vi.spyOn(nocow, "repairDoctorSqliteNoCow").mockImplementation(async () => {
    expect(boundary.close).toHaveBeenCalled();
    fs.copyFileSync(pathname, `${pathname}.new`);
    fs.renameSync(`${pathname}.new`, pathname);
    return { changes: ["NOCOW rewrite complete"], warnings: [] };
  });
  const maintenance = await beginWithGenerations(generations);
  await maintenance!.repairSqliteNoCow([pathname]);
  await maintenance!.release();
  expect(rewrite).toHaveBeenCalledOnce();
  // Independent SQLite writers are not excluded during the rewrite, so even this
  // Doctor-owned replacement cannot be attributed and must not be auto-restored.
  expect(maintenance!.databaseWrites).toEqual({
    unchanged: false,
    fromGenerations: generations,
    generations: await readUpdatePhysicalDatabaseGenerations([pathname]),
  });
  expect(maintenance!.databaseWrites?.generations[pathname]).not.toBe(generations[pathname]);
  expect(maintenance!.warnings).not.toContain("NOCOW rewrite complete");
  await expect(maintenance!.repairSqliteNoCow([pathname])).rejects.toThrow(
    "original live maintenance owner",
  );
});

it("keeps fingerprint failures advisory and publishes no database write proof", async () => {
  fingerprintReads();
  const pathname = path.join(settlement.tempDirs.make("doctor-write-proof-unavailable-"), "db");
  fs.mkdirSync(pathname);
  const maintenance = await beginWithGenerations({ [pathname]: null });
  await expect(maintenance!.finish({})).resolves.toBeUndefined();
  expect(maintenance!.databaseWrites).toBeUndefined();
  expect(maintenance!.warnings).toContainEqual(
    expect.stringContaining("Database write verification is unavailable"),
  );
  await maintenance!.release();
});

it.each([
  { phase: "admission", cleanup: "uncertain" },
  { phase: "receipt", cleanup: "forced" },
  { phase: "receipt", cleanup: "uncertain" },
] as const)(
  "joins database $phase workers before releasing state custody ($cleanup)",
  async ({ phase, cleanup }) => {
    const barrier = cleanupBarrier();
    const databaseGenerations = { "/synthetic/doctor-state/state/openclaw.sqlite": null };
    let reads = 0;
    vi.spyOn(updateState, "readUpdateDatabaseGenerationsIsolated").mockImplementation(async () => {
      reads++;
      if (reads === (phase === "admission" ? 1 : 2)) {
        barrier.retain();
      }
      return databaseGenerations;
    });
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    const work = (async () => {
      maintenance = await beginWithGenerations(databaseGenerations, root);
      await maintenance!.finish({});
    })().catch((error: unknown) => error);
    const error = await settleCleanup(work, barrier, cleanup, () => {
      expect(boundary.release).not.toHaveBeenCalled();
      if (phase === "admission") {
        expect(boundary.stop).toHaveBeenCalledTimes(1);
      }
      expectCalls(0, "resume", "restart");
      expect(maintenance?.databaseWrites).toBeUndefined();
    });
    if (cleanup === "forced") {
      expect(error).toBeUndefined();
      expectCalls(1, "release", "restart");
      expect(maintenance?.databaseWrites).toEqual({
        unchanged: true,
        fromGenerations: databaseGenerations,
        generations: databaseGenerations,
      });
      return;
    }
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    expect(maintenance?.databaseWrites).toBeUndefined();
    if (maintenance) {
      await expect(maintenance.release()).rejects.toSatisfy(hasCommandProcessCleanupError);
      await expect(maintenance.releaseState()).rejects.toSatisfy(hasCommandProcessCleanupError);
    }
    expectCalls(0, "release", "resume", "complete", "restart");
  },
);

it("restores the stopped Gateway before reporting a settled state-owner release failure", async () => {
  const failure = new Error("settled state-owner release failed");
  boundary.release.mockRejectedValueOnce(failure);
  const maintenance = await begin();

  await expect(maintenance!.finish({})).rejects.toBe(failure);
  expectCalls(1, "close", "resume", "restart", "health");
});

it("reports a settled state-release failure without a managed Gateway", async () => {
  const failure = new Error("settled state release failed");
  const maintenance = await beginWithGenerations();
  boundary.release.mockRejectedValueOnce(failure);
  await expect(maintenance!.finish(undefined)).rejects.toBe(failure);
  expectCalls(1, "close");
  expectCalls(0, "restart");
});

it.each(["persistent", "transient"] as const)(
  "settles %s resource close failure before restoration",
  async (mode) => {
    const failure = new Error(`${mode} resource close failure`);
    if (mode === "persistent") {
      boundary.close.mockRejectedValue(failure);
    } else {
      boundary.close.mockRejectedValueOnce(failure);
    }
    const maintenance = await begin();
    const finish = expect(maintenance!.finish({})).rejects;
    if (mode === "transient") {
      await finish.toBe(failure);
    } else {
      await finish.toThrow("Doctor maintenance resource cleanup failed");
    }
    expectCalls(2, "close");
    expectCalls(mode === "transient" ? 1 : 0, "release", "restart", "health");
    if (mode === "persistent") {
      expect(maintenance!.databaseWrites).toBeUndefined();
    }
  },
);

it("does not restart a Gateway already activated by config repair", async () => {
  const events: string[] = [];
  const read = boundary.read.getMockImplementation()!;
  boundary.repair.mockImplementation(async () => {
    expect(boundary.release).toHaveBeenCalled();
    events.push("repair");
    boundary.read.mockImplementation(async (...args) => ({
      ...(await read(...args)),
      running: true,
      runtime: { status: "running" },
    }));
    return {};
  });
  boundary.restart.mockImplementation(async () => events.push("restart"));
  const maintenance = await begin();
  await maintenance!.finish({}, async (config) => config);
  expect(events).toEqual(["repair"]);
  expect(boundary.health).toHaveBeenCalledOnce();
});

it("does not suggest an unsafe manual stop after a reported write-custody refusal", async () => {
  const refusal = new GatewayServiceStopUnsafeError(
    "Gateway maintenance stop refused: data at risk in owner phase migration (1).",
  );
  boundary.stop.mockImplementation(async (params) => {
    if (params.phase === "inspect") {
      return { ...settlement.stopped, stopped: false, running: true, offline: false };
    }
    throw refusal;
  });
  const error = await begin().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(refusal.message);
  expect(String(error)).not.toContain("Stop the Gateway service and other OpenClaw processes");
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("releases its acquired process owner without deferring a one-shot authority refusal", async () => {
  const refused = new Error("Synthetic revoked update authority");
  let revoked = false;
  const assertCurrent = vi.fn(() => {
    if (!revoked && boundary.gatewayAcquire.mock.calls.length) {
      revoked = true;
      throw refused;
    }
  });
  await expect(begin(assertCurrent)).rejects.toBe(refused);
  expectCalls(1, "release");
  expectCalls(0, "restart");
  expectCalls(1, "stop");
});

it("preserves caller cancellation after a settled maintenance inspection", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Synthetic update cancellation");
  boundary.stop.mockImplementation(async () => {
    controller.abort(cancelled);
    return {
      stopped: false,
      inspected: false,
      runtimeInspected: false,
      running: false,
      serviceUpdateVerdict: { kind: "unavailable", message: "Inspection was cancelled." },
    };
  });
  boundary.gatewayAcquire.mockImplementation(() => {
    throw new GatewayStateOwnerContentionError("/synthetic/doctor-state/state/openclaw.sqlite");
  });
  await expect(withCommandProcessScope(() => begin(), controller.signal)).rejects.toBe(cancelled);
  expectCalls(1, "stop");
  expectCalls(0, "restart");
});

it.each(["forced", "uncertain"] as const)(
  "joins failed maintenance admission before compensating (%s)",
  async (cleanup) => {
    const barrier = cleanupBarrier();
    const original = new Error("service stop failed after parking the Gateway");
    afterStop(() => {
      barrier.retain();
      throw original;
    });
    const work = begin().catch((error: unknown) => error);
    const error = await settleCleanup(work, barrier, cleanup, () => {
      expectCalls(0, "resume", "complete", "restart", "release");
    });
    expect(collectNestedErrorCandidates(error)).toContain(original);
    expect(hasCommandProcessCleanupError(error)).toBe(cleanup === "uncertain");
    expectCalls(cleanup === "forced" ? 1 : 0, "restart", "resume", "complete");
    if (cleanup === "uncertain") {
      expect(boundary.release).not.toHaveBeenCalled();
    }
  },
);

it.each([
  { phase: "inspection", cleanup: "uncertain" },
  { phase: "autostart", cleanup: "uncertain" },
  { phase: "installation", cleanup: "forced" },
  { phase: "installation", cleanup: "uncertain" },
] as const)(
  "settles restoration $phase and retains unknown cleanup ($cleanup)",
  async ({ phase, cleanup }) => {
    if (phase === "installation") {
      settlement.stopped.serviceUpdateVerdict = {
        kind: "owned",
        root: "/synthetic/service-install",
        fingerprint: "fixture",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      };
      boundary.revalidate.mockResolvedValueOnce(settlement.stopped.serviceUpdateVerdict);
    }
    const maintenance = await begin();
    if (!maintenance) {
      throw new Error("The repair did not acquire maintenance");
    }
    boundary.unlock.mockClear();
    const barrier = cleanupBarrier();
    if (phase === "inspection") {
      const read = boundary.read.getMockImplementation()!;
      boundary.read.mockImplementation(async (...args) => {
        barrier.retain();
        return await read(...args);
      });
    } else if (phase === "autostart") {
      boundary.resume.mockImplementation(async () => barrier.retain());
    } else {
      boundary.repair.mockImplementation(async () => {
        barrier.retain();
        return {};
      });
    }
    const work = maintenance.finish({}).catch((error: unknown) => error);
    const error = await settleCleanup(work, barrier, cleanup, () => {
      expectCalls(0, "restart", "health", "unlock");
      if (phase === "autostart") {
        expectCalls(0, "complete", "read");
      } else if (phase === "installation") {
        expectCalls(1, "read", "revalidate");
        expectCalls(0, "resume");
        expect(boundary.complete).toHaveBeenCalledExactlyOnceWith(false);
      }
    });
    if (cleanup === "forced") {
      expect(error).toBeUndefined();
      expectCalls(0, "restart");
      expectCalls(1, "health");
      expectCalls(2, "read", "revalidate");
      expectCalls(1, "repair");
      expect(boundary.log).toHaveBeenCalledWith(
        "Gateway restarted and verified after Doctor repair.",
      );
      return;
    }
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    const resumes = boundary.resume.mock.calls.length;
    const completions = boundary.complete.mock.calls.length;
    const releases = boundary.release.mock.calls.length;
    for (const release of [
      () => maintenance.release(),
      () => maintenance.finish({}),
      () => maintenance.releaseState(),
    ]) {
      const refusal = await release().catch((failure: unknown) => failure);
      expect(hasCommandProcessCleanupError(refusal)).toBe(true);
    }
    expectCalls(resumes, "resume");
    expectCalls(completions, "complete");
    expectCalls(releases, "release");
    expectCalls(0, "restart", "health");
    expect(boundary.log).not.toHaveBeenCalledWith(
      "Gateway restarted and verified after Doctor repair.",
    );
  },
);

it("waits for the stopped Gateway to release lifecycle ownership", async () => {
  let elapsed = 0;
  let ticks = 0;
  let loaded = true;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
  const acquire = boundary.gatewayAcquire.getMockImplementation()!;
  boundary.gatewayAcquire.mockImplementation(() => {
    if (ticks < 3) {
      throw new GatewayStateOwnerContentionError("/synthetic/doctor-state/state/openclaw.sqlite");
    }
    return acquire();
  });
  boundary.sleep.mockImplementation(async (ms: number) => {
    expect(loaded).toBe(false);
    expect(boundary.restart).not.toHaveBeenCalled();
    elapsed += ms;
    ticks++;
  });
  afterStop(() => {
    loaded = false;
  });
  boundary.restart.mockImplementation(async () => {
    loaded = true;
  });

  const maintenance = await begin();
  expect(ticks).toBe(3);
  expect(boundary.restart).not.toHaveBeenCalled();
  await maintenance!.finish({});
  expect(loaded).toBe(true);
  expect(boundary.restart).toHaveBeenCalledOnce();
});

it("restores a service after state ownership fails without retaining a partial maintenance scope", async () => {
  boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
  let heldLeases = 0;
  const acquire = boundary.gatewayAcquire.getMockImplementation()!;
  boundary.gatewayAcquire
    .mockImplementation(() => {
      heldLeases++;
      return {
        ...acquire(),
        release: () => {
          heldLeases--;
        },
      };
    })
    .mockImplementationOnce(() => {
      throw new GatewayStateOwnerContentionError("/synthetic/doctor-state/state/openclaw.sqlite");
    });
  boundary.ownerAssert.mockImplementation(() => {
    throw new Error("state ownership changed before repair");
  });
  await expect(begin()).rejects.toThrow(/state ownership changed before repair/);
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(heldLeases).toBe(0);
  expect(boundary.sleep).not.toHaveBeenCalled();
});

it.each(["acquired", "native-revoked", "install-drift"] as const)(
  "refuses changed repair admission and compensates under original service custody (%s)",
  async (phase) => {
    if (phase === "install-drift") {
      settlement.stopped.serviceUpdateVerdict = {
        kind: "owned",
        root,
        fingerprint: "fixture",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      };
      boundary.revalidate.mockResolvedValue(settlement.stopped.serviceUpdateVerdict);
    }
    let ticks = 0;
    let gatewayHeld = false;
    let ownerVerified = false;
    let conflict = false;
    let checkedUnderOwner = false;
    let stopCustody: (() => void) | undefined;
    let capturedStopAdmission: (() => void) | undefined;
    boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
    const acquire = boundary.gatewayAcquire.getMockImplementation()!;
    boundary.gatewayAcquire.mockImplementation(() => {
      if (ticks < 2) {
        throw new GatewayStateOwnerContentionError("/synthetic/doctor-state/state/openclaw.sqlite");
      }
      gatewayHeld = true;
      return {
        ...acquire(),
        release: () => {
          gatewayHeld = false;
        },
      };
    });
    boundary.ownerAssert.mockImplementation(() => {
      expect(gatewayHeld).toBe(true);
      ownerVerified = true;
      conflict = true;
    });
    boundary.sleep.mockImplementation(async () => {
      ticks++;
    });
    boundary.admission.mockImplementation(() => {
      checkedUnderOwner ||= gatewayHeld && ownerVerified;
      return conflict
        ? { kind: "conflict", message: "repair admission conflict" }
        : { kind: "recovery", runs: [] };
    });
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      if (params.phase !== "inspect") {
        stopCustody = boundary.scopeAssert;
        capturedStopAdmission = params.assertCurrent;
      }
      return await stop(params);
    });
    boundary.resume.mockImplementation(async () => {
      // Windows autostart recovery retains the caller assertion supplied at stop.
      capturedStopAdmission?.();
    });
    boundary.authority.mockImplementation(() => {
      if (phase === "native-revoked" && conflict) {
        throw new Error("native operation custody retired");
      }
    });
    boundary.restart.mockImplementation(async () => {
      expect(stopCustody).toBeTypeOf("function");
      stopCustody!();
      expect(gatewayHeld).toBe(false);
    });
    const refusal = await begin().catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/repair admission conflict|native operation custody retired/);
    expect(refusal).not.toBeInstanceOf(DoctorMaintenanceRefusalError);
    expect(checkedUnderOwner).toBe(true);
    expect(boundary.restart).toHaveBeenCalledTimes(
      phase === "native-revoked" || phase === "install-drift" ? 0 : 1,
    );
    expect(boundary.repair).not.toHaveBeenCalled();
    expect(boundary.complete).toHaveBeenCalled();
    expect(boundary.close).toHaveBeenCalledOnce();
    expect(gatewayHeld).toBe(false);
  },
);

it.each([false, true])(
  "restores within the shared stop budget when ownerless cleanup persists (stopFailed=%s)",
  async (stopFailed) => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    let elapsed = 0;
    let parked = false;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    boundary.owner.mockImplementation(() =>
      parked ? undefined : { state: "live", mode: "supervised" },
    );
    boundary.gatewayAcquire.mockImplementation(() => {
      throw new GatewayStateOwnerContentionError("/synthetic/doctor-state/state/openclaw.sqlite");
    });
    boundary.sleep.mockImplementation(async (ms: number) => {
      expect(parked).toBe(true);
      expect(boundary.restart).not.toHaveBeenCalled();
      elapsed += ms;
    });
    const stopError = new Error("service stop failed after parking");
    afterStop(() => {
      parked = true;
      elapsed = GATEWAY_SERVICE_STOP_TIMEOUT_MS - 1_250;
      if (stopFailed) {
        throw stopError;
      }
    });
    const refusal = await begin(() => {}).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    if (stopFailed) {
      expect(collectNestedErrorCandidates(refusal)).toContain(stopError);
    } else {
      expect(String(refusal)).toContain("OpenClaw state database is busy at");
    }
    expect(elapsed).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
    expectCalls(0, "ownerAssert", "lease", "close");
    expectCalls(1, "restart", "health");
    expect(boundary.log).toHaveBeenCalledWith(
      expect.stringMatching(/Warning:.*state ownership.*Restoring its service/),
    );
  },
);

it("leaves an already stopped Gateway with its legacy update parent after repair", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  boundary.stop.mockImplementation(async () => ({ ...settlement.stopped, stopped: false }));
  const maintenance = await begin();
  await maintenance!.finish({});
  expectCalls(0, "restart", "health");
});

const leaseGuidance =
  "Doctor could not enter maintenance. An agent database is in use. Stop the Gateway and other OpenClaw processes or reboot, then rerun openclaw doctor --fix.";
const leaseCode = "agent-database-lease-active";
const leaseFact = { check: "doctor", code: leaseCode, message: leaseGuidance };
const privateCause =
  "private-lease-class /synthetic/private-state/private.db token=fixture-only-token alice@example.invalid";

it("refuses an external active agent lease before serving-Gateway coordinator contention", async () => {
  boundary.external.mockReturnValue(true);
  boundary.readLeases.mockReturnValue([
    {
      agent_id: "private-agent",
      lease_id: "private-lease",
      owner_pid: 4242,
      owner_start_time: 123,
      opened_at: 1,
      provenance: null,
      path: "/synthetic/private-state/private.db",
    },
  ]);
  boundary.gatewayAcquire.mockImplementation(() => {
    throw new Error("another OpenClaw process owns gateway-lifecycle");
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ message: leaseGuidance });
  const facts = collectUpdateDoctorFailureFacts(refusal);
  expect(facts).toEqual([leaseFact]);
  expect(await projectPublicUpdateFailureIdentifiers(facts[0]!)).toEqual({
    check: "doctor",
    code: leaseCode,
  });
  expect(JSON.stringify(facts)).not.toContain("private");
  expectCalls(1, "readLeases");
  expectCalls(0, "gatewayAcquire", "ownerAssert", "lease", "stop", "restart", "close", "release");
});

it("does not use an empty external lease observation to bypass coordinator contention", async () => {
  boundary.external.mockReturnValue(true);
  const contention = new Error("another OpenClaw process owns gateway-lifecycle");
  fail("gatewayAcquire", contention);
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toMatchObject({ cause: contention });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expectCalls(1, "readLeases", "gatewayAcquire");
  expectCalls(0, "ownerAssert", "lease", "stop", "close");
});

it("rechecks external leases under the process owner after an empty observation", async () => {
  boundary.external.mockReturnValue(true);
  boundary.lease.mockImplementation(() => {
    throw new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([leaseFact]);
  expectCalls(1, "readLeases", "gatewayAcquire", "ownerAssert");
  expectOrder("readLeases", "gatewayAcquire");
  expectOrder("ownerAssert", "lease");
  expectCalls(1, "release");
  expectCalls(0, "stop");
  expectCalls(1, "close");
  expectOrder("close", "release");
});

it.each(["unknown", "unreadable"] as const)(
  "preserves %s-state refusal after an external diagnostic read fails",
  async (schema) => {
    boundary.external.mockReturnValue(true);
    const cause =
      schema === "unknown"
        ? Object.assign(new Error(privateCause), {
            name: "OpenClawAgentDatabaseLeaseActiveError",
            code: leaseCode,
          })
        : new Error("synthetic unreadable schema");
    fail("readLeases", cause);
    fail("lease", cause);
    if (schema === "unreadable") {
      boundary.schemas.mockResolvedValue({
        indeterminate: [
          {
            kind: "state",
            path: "/synthetic/doctor-state/state/openclaw.sqlite",
            reason: "not a database",
          },
        ],
      });
    }
    const refusal: unknown = await begin().catch((error: unknown) => error);
    if (schema === "unreadable") {
      expect(refusal).toBeInstanceOf(DoctorUnreadableStateDatabaseError);
      expect(String(refusal)).toContain("restore this file from a verified backup");
    } else {
      expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
      expect(refusal).toMatchObject({
        cause,
        refusal: { kind: "deferred", reason: "admission-unavailable" },
      });
      expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
      expect(
        redactPublicSupportDiagnosticLine(String(refusal), {
          env: {},
          stateDir: "/synthetic/private-state",
        }),
      ).toBe("DoctorMaintenanceRefusalError: Doctor could not enter maintenance.");
    }
    expectCalls(1, "gatewayAcquire", "ownerAssert", "lease", "release", "close");
    expectCalls(0, "stop");
    expectOrder("close", "release");
  },
);

it("carries an actual typed lease refusal through Doctor IPC, finalization and public projection", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  fail("lease", cause);
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ cause, message: leaseGuidance });
  expectCalls(0, "readLeases");
  expectCalls(1, "close", "release");
  expectOrder("close", "release");
  expectCalls(1, "resume", "complete", "restart");
  expectOrder("release", "resume");
  expectOrder("complete", "restart");

  const facts = collectUpdateDoctorFailureFacts(refusal);
  expect(facts).toEqual([leaseFact]);
  vi.stubEnv("OPENCLAW_TMP_DIR", tempDirs.make("openclaw-typed-refusal-"));
  const resultPath = createUpdatePostInstallDoctorResultPath();
  await writeUpdatePostInstallDoctorResult({
    resultPath,
    result: { status: "error", failureFacts: facts },
  });
  const result = await consumeUpdatePostInstallDoctorResult(resultPath);
  expect(result).toEqual({ status: "error", failureFacts: facts });
  if (!result?.failureFacts) {
    throw new Error("Missing Doctor refusal result");
  }
  // Model the existing parent conversion after reading the child's error result.
  const parentError = new UpdateDoctorError(leaseGuidance, result.failureFacts, { exitCode: 1 });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await expect(
    lifecycle.run("doctor", async () => {
      throw parentError;
    }),
  ).rejects.toBe(parentError);
  lifecycle.fail();
  expect(boundary.finish).toHaveBeenCalledWith(
    "typed-refusal-run",
    { status: "failed" },
    expect.anything(),
  );
  const failed = boundary.step.mock.calls
    .map((call) => call[1])
    .find((step) => step.status === "failed");
  expect(failed).toMatchObject({
    step: "finalize:doctor",
    reason: leaseCode,
    exitCode: 1,
    failureFacts: facts,
  });
  const fact = failed?.failureFacts?.[0];
  if (!fact?.message) {
    throw new Error("Finalization lost the refusal fact");
  }
  const publicFact = {
    ...(await projectPublicUpdateFailureIdentifiers(fact)),
    message: redactPublicSupportDiagnosticLine(fact.message, {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  };
  expect(publicFact).toEqual(leaseFact);
  expect(JSON.stringify({ result, failed, publicFact })).not.toContain(privateCause);
});

it("retains the typed refusal and restoration failure in the aggregate", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  const restore = new Error("synthetic restoration failure");
  fail("lease", cause);
  boundary.resume.mockRejectedValue(restore);
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AggregateError);
  expect(refusal).toMatchObject({
    cause: restore,
    errors: [expect.any(UpdateDoctorError), restore],
  });
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([leaseFact]);
  expectCalls(1, "release", "complete");
  expectCalls(0, "restart");
});

it("does not settle a typed refusal while command cleanup remains uncertain", async () => {
  const barrier = cleanupBarrier();
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    barrier.retain();
    throw cause;
  });
  const work = begin().catch((error: unknown) => error);
  const refusal = await settleCleanup(work, barrier, "uncertain", () => {
    expect(boundary.release).not.toHaveBeenCalled();
  });
  expect(hasCommandProcessCleanupError(refusal)).toBe(true);
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([leaseFact]);
  expectCalls(0, "release", "resume", "complete", "restart");
});

it.each([
  "owned-offline",
  "running-indicator",
  "unknown-runtime",
  "unknown-load",
  "read-failed",
  "not-ours",
])("rechecks an initially stopped Gateway after config repair: %s", async (outcome) => {
  boundary.stop.mockImplementation(async () => ({ ...settlement.stopped, stopped: false }));
  const state = {
    ...(await boundary.read(resolveGatewayService())),
    loadState: { status: "not-loaded" as const },
  };
  boundary.read.mockResolvedValue(state);
  boundary.repair.mockImplementation(async () => {
    if (outcome === "read-failed") {
      boundary.read.mockRejectedValue(new Error("Synthetic final inspection failed"));
    } else {
      boundary.read.mockResolvedValue({
        ...state,
        running: outcome === "running-indicator",
        loadState:
          outcome === "unknown-load"
            ? { status: "unknown", detail: "probe failed" }
            : state.loadState,
        runtime: {
          status: outcome === "unknown-runtime" ? "unknown" : "stopped",
        },
      });
      if (outcome === "not-ours") {
        boundary.revalidate.mockResolvedValue({ kind: "foreign" });
      }
    }
    return {};
  });
  const maintenance = await begin();
  await expect(maintenance!.finish({}, async (cfg) => cfg)).resolves.toBeUndefined();
  expectCalls(1, "repair");
  expectCalls(outcome === "owned-offline" ? 1 : 0, "restart");
  const verified = outcome === "owned-offline";
  expect(boundary.health).toHaveBeenCalledTimes(verified ? 1 : 0);
  if (!verified) {
    expect(maintenance!.warnings).toContainEqual(
      expect.stringMatching(/Gateway activation skipped.*gateway status --deep/),
    );
  }
});
