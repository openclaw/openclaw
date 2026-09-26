import "./doctor-maintenance.settlement.test-support.js";
import { expect, it, vi } from "vitest";
import { UpdateFinalizationLifecycle } from "../cli/update-cli/update-finalization-lifecycle.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  DoctorMaintenanceRefusalError,
  UpdateDoctorError,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { projectPublicUpdateFailureIdentifiers } from "../infra/update-failure-public-identifiers.js";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { defaultRuntime } from "../runtime.js";
import { OpenClawAgentDatabaseLeaseActiveError } from "../state/openclaw-agent-db-lease.js";

const { begin, boundary, cleanupBarrier, tempDirs } =
  await import("./doctor-maintenance.settlement.test-support.js");

const leaseGuidance =
  "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.";
const leaseCode = "agent-database-lease-active";
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
  expect(facts).toEqual([{ check: "doctor", code: leaseCode, message: leaseGuidance }]);
  expect(await projectPublicUpdateFailureIdentifiers(facts[0]!)).toEqual({
    check: "doctor",
    code: leaseCode,
  });
  expect(JSON.stringify(facts)).not.toContain("private");
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).not.toHaveBeenCalled();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.lease).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.release).not.toHaveBeenCalled();
});

it("does not use an empty external lease observation to bypass coordinator contention", async () => {
  boundary.external.mockReturnValue(true);
  const contention = new Error("another OpenClaw process owns gateway-lifecycle");
  boundary.gatewayAcquire.mockImplementation(() => {
    throw contention;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toMatchObject({ cause: contention });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.lease).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("rechecks external leases under both coordinators after an empty observation", async () => {
  boundary.external.mockReturnValue(true);
  boundary.lease.mockImplementation(() => {
    throw new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.readLeases.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.gatewayAcquire.mock.invocationCallOrder[0]!,
  );
  expect(boundary.stateAcquire.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.lease.mock.invocationCallOrder[0]!,
  );
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("fails closed on an unknown external lease observation without exposing private details", async () => {
  boundary.external.mockReturnValue(true);
  const cause = Object.assign(new Error(privateCause), {
    name: "OpenClawAgentDatabaseLeaseActiveError",
    code: leaseCode,
  });
  boundary.readLeases.mockImplementation(() => {
    throw cause;
  });
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toMatchObject({ cause });
  expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect(refusal).toMatchObject({ refusal: { kind: "deferred", reason: "admission-unavailable" } });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(
    redactPublicSupportDiagnosticLine(String(refusal), {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  ).toBe("DoctorMaintenanceRefusalError: Doctor could not enter maintenance.");
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("grants external maintenance only after the unchanged held-owner checks", async () => {
  boundary.external.mockReturnValue(true);
  const maintenance = await begin();
  expect(maintenance).toBeDefined();
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.lease.mock.invocationCallOrder[0]!,
  );
  expect(boundary.stop).not.toHaveBeenCalled();
  await maintenance!.release();
  expect(boundary.close).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
});

it("preserves held-owner unreadable-state guidance after an external diagnostic read fails", async () => {
  boundary.external.mockReturnValue(true);
  const failure = new Error("synthetic unreadable schema");
  boundary.readLeases.mockImplementation(() => {
    throw failure;
  });
  boundary.lease.mockImplementation(() => {
    throw failure;
  });
  boundary.schemas.mockResolvedValue({
    indeterminate: [
      {
        kind: "state",
        path: "/synthetic/doctor-state/state/openclaw.sqlite",
        reason: "not a database",
      },
    ],
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DoctorUnreadableStateDatabaseError);
  expect(String(refusal)).toContain("restore this file from a verified backup");
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
});

it("carries an actual typed lease refusal through Doctor IPC, finalization and public projection", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ cause, message: leaseGuidance });
  expect(boundary.readLeases).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.resume).toHaveBeenCalledOnce();
  expect(boundary.complete).toHaveBeenCalledOnce();
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(boundary.release.mock.invocationCallOrder[1]).toBeLessThan(
    boundary.resume.mock.invocationCallOrder[0]!,
  );
  expect(boundary.complete.mock.invocationCallOrder[0]).toBeLessThan(
    boundary.restart.mock.invocationCallOrder[0]!,
  );

  const facts = collectUpdateDoctorFailureFacts(refusal);
  expect(facts).toEqual([{ check: "doctor", code: leaseCode, message: leaseGuidance }]);
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
  expect(publicFact).toEqual({ check: "doctor", code: leaseCode, message: leaseGuidance });
  expect(JSON.stringify({ result, failed, publicFact })).not.toContain(privateCause);
});

it("retains the typed refusal and restoration failure in the aggregate", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  const restore = new Error("synthetic restoration failure");
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  boundary.resume.mockRejectedValue(restore);
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AggregateError);
  expect(refusal).toMatchObject({
    cause: restore,
    errors: [expect.any(UpdateDoctorError), restore],
  });
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.complete).toHaveBeenCalledOnce();
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("does not settle a typed refusal while command cleanup remains uncertain", async () => {
  const barrier = cleanupBarrier();
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    barrier.retain();
    throw cause;
  });
  const work = begin().catch((error: unknown) => error);
  try {
    await Promise.race([
      barrier.joining,
      work.then(() => {
        throw new Error("Admission settled before command cleanup");
      }),
    ]);
    expect(boundary.release).not.toHaveBeenCalled();
  } finally {
    barrier.cleanup.resolve("uncertain");
    await work;
  }
  const refusal = await work;
  expect(hasCommandProcessCleanupError(refusal)).toBe(true);
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.release).not.toHaveBeenCalled();
  expect(boundary.resume).not.toHaveBeenCalled();
  expect(boundary.complete).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("does not classify a forged lease error name, code or message", async () => {
  const cause = Object.assign(new Error(privateCause), {
    name: "OpenClawAgentDatabaseLeaseActiveError",
    code: leaseCode,
  });
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect(refusal).toMatchObject({ refusal: { kind: "deferred", reason: "admission-unavailable" } });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(
    redactPublicSupportDiagnosticLine(String(refusal), {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  ).toBe("DoctorMaintenanceRefusalError: Doctor could not enter maintenance.");
});
