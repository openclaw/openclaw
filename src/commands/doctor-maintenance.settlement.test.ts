import "./doctor-maintenance.settlement.test-support.js";
import { expect, it, vi } from "vitest";
import { GatewayServiceStopUnsafeError } from "../daemon/service-inspection-error.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";

const settlement = await import("./doctor-maintenance.settlement.test-support.js");
const { begin, boundary, cleanupBarrier, root } = settlement;

it.each([false, true])(
  "checks same-installation policy before restoring Doctor's Gateway (repair activated=%s)",
  async (activated) => {
    const events: string[] = [];
    const read = boundary.read.getMockImplementation()!;
    boundary.repair.mockImplementation(async () => {
      expect(boundary.release).toHaveBeenCalled();
      events.push("repair");
      boundary.read.mockImplementation(async (...args) => ({
        ...(await read(...args)),
        running: activated,
        runtime: { status: activated ? "running" : "stopped" },
      }));
      return {};
    });
    boundary.restart.mockImplementation(async () => events.push("restart"));
    const maintenance = await begin();
    await maintenance!.finish({}, async (config) => config);
    expect(events).toEqual(activated ? ["repair"] : ["repair", "restart"]);
    expect(boundary.health).toHaveBeenCalledOnce();
  },
);

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

it("releases its acquired coordinator without deferring a one-shot authority refusal", async () => {
  const refused = new Error("Synthetic revoked update authority");
  let revoked = false;
  const assertCurrent = vi.fn(() => {
    if (!revoked && boundary.gatewayAcquire.mock.calls.length) {
      revoked = true;
      throw refused;
    }
  });
  await expect(begin(assertCurrent)).rejects.toBe(refused);
  expect(boundary.release).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
  expect(boundary.stop).toHaveBeenCalledOnce();
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
    throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
  });
  await expect(withCommandProcessScope(() => begin(), controller.signal)).rejects.toBe(cancelled);
  expect(boundary.stop).toHaveBeenCalledOnce();
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("leaves a progressing Gateway running and warns after the readiness cap", async () => {
  boundary.health.mockResolvedValue({
    healthy: false,
    staleGatewayPids: [],
    runtime: { status: "running", pid: 4242 },
    portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
    waitOutcome: "still-starting",
    elapsedMs: 300_000,
    startupPhase: "startup migration",
  });
  const maintenance = await begin();
  expect(maintenance).toBeDefined();

  await expect(maintenance!.finish({})).resolves.toBeUndefined();

  const warning = expect.stringMatching(
    /still starting after 300s.*startup migration.*openclaw gateway status --deep/,
  );
  expect(maintenance!.warnings).toContainEqual(warning);
  expect(boundary.log).toHaveBeenCalledWith(warning);
  expect(boundary.log).not.toHaveBeenCalledWith(
    "Gateway restarted and verified after Doctor repair.",
  );
  expect(boundary.restart).toHaveBeenCalledOnce();
});

it.each(["forced", "uncertain"] as const)(
  "joins failed maintenance admission before compensating (%s)",
  async (cleanup) => {
    const barrier = cleanupBarrier();
    const original = new Error("service stop failed after parking the Gateway");
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        barrier.retain();
        throw original;
      }
      return result;
    });
    const work = begin().catch((error: unknown) => error);
    try {
      await Promise.race([
        barrier.joining,
        work.then(() => {
          throw new Error("Admission compensated before physical cleanup joined");
        }),
      ]);
      expect(boundary.resume).not.toHaveBeenCalled();
      expect(boundary.complete).not.toHaveBeenCalled();
      expect(boundary.restart).not.toHaveBeenCalled();
      expect(boundary.release).not.toHaveBeenCalled();
    } finally {
      barrier.cleanup.resolve(cleanup);
      await work;
    }
    const error = await work;
    expect(collectNestedErrorCandidates(error)).toContain(original);
    expect(hasCommandProcessCleanupError(error)).toBe(cleanup === "uncertain");
    expect(boundary.restart).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    expect(boundary.resume).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    expect(boundary.complete).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    if (cleanup === "uncertain") {
      expect(boundary.release).not.toHaveBeenCalled();
    }
  },
);

it.each(
  (["inspection", "autostart", "installation"] as const).flatMap((phase) =>
    (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
  ),
)(
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
    try {
      await Promise.race([
        barrier.joining,
        work.then(() => {
          throw new Error("Restoration advanced before physical cleanup joined");
        }),
      ]);
      expect(boundary.restart).not.toHaveBeenCalled();
      expect(boundary.health).not.toHaveBeenCalled();
      expect(boundary.unlock).not.toHaveBeenCalled();
      if (phase === "autostart") {
        expect(boundary.complete).not.toHaveBeenCalled();
        expect(boundary.read).not.toHaveBeenCalled();
      } else if (phase === "installation") {
        expect(boundary.read).toHaveBeenCalledOnce();
        expect(boundary.revalidate).toHaveBeenCalledOnce();
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(boundary.complete).toHaveBeenCalledExactlyOnceWith(false);
      }
    } finally {
      barrier.cleanup.resolve(cleanup);
      await work;
    }
    const error = await work;
    if (cleanup === "forced") {
      expect(error).toBeUndefined();
      expect(boundary.restart).toHaveBeenCalledTimes(phase === "installation" ? 0 : 1);
      expect(boundary.health).toHaveBeenCalledOnce();
      if (phase === "installation") {
        expect(boundary.read).toHaveBeenCalledTimes(2);
        expect(boundary.revalidate).toHaveBeenCalledTimes(2);
        expect(boundary.repair).toHaveBeenCalledOnce();
      }
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
    expect(boundary.resume).toHaveBeenCalledTimes(resumes);
    expect(boundary.complete).toHaveBeenCalledTimes(completions);
    expect(boundary.release).toHaveBeenCalledTimes(releases);
    expect(boundary.restart).not.toHaveBeenCalled();
    expect(boundary.health).not.toHaveBeenCalled();
    expect(boundary.log).not.toHaveBeenCalledWith(
      "Gateway restarted and verified after Doctor repair.",
    );
  },
);

it.each([false, true])(
  "waits for the stopped Gateway's lifecycle ownership (expires=%s)",
  async (expires) => {
    let elapsed = 0;
    let ticks = 0;
    let loaded = true;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
    const acquire = boundary.gatewayAcquire.getMockImplementation()!;
    boundary.gatewayAcquire.mockImplementation(() => {
      if (expires || ticks < 3) {
        throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
      }
      return acquire();
    });
    boundary.sleep.mockImplementation(async (ms: number) => {
      expect(loaded).toBe(false);
      expect(boundary.restart).not.toHaveBeenCalled();
      elapsed += ms;
      ticks++;
    });
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        loaded = false;
      }
      return result;
    });
    boundary.restart.mockImplementation(async () => {
      loaded = true;
    });

    if (expires) {
      await expect(begin()).rejects.toThrow(/gateway-lifecycle/);
      expect(elapsed).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
      expect(boundary.log).toHaveBeenCalledWith(
        expect.stringMatching(/Warning:.*gateway-lifecycle.*openclaw doctor --fix/),
      );
    } else {
      const maintenance = await begin();
      expect(ticks).toBe(3);
      expect(boundary.restart).not.toHaveBeenCalled();
      await maintenance!.finish({});
    }
    expect(loaded).toBe(true);
    expect(boundary.restart).toHaveBeenCalledOnce();
  },
);

it("restores a service after state ownership fails without retaining a partial maintenance scope", async () => {
  boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
  let heldLeases = 0;
  boundary.gatewayAcquire
    .mockImplementation(() => {
      heldLeases++;
      return {
        release: () => {
          heldLeases--;
        },
        createSchemaFenceDelegate: vi.fn(),
      };
    })
    .mockImplementationOnce(() => {
      throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
    });
  boundary.stateAcquire.mockImplementation(() => {
    throw new StateDatabaseCoordinatorContentionError("state-lifecycle");
  });
  await expect(begin()).rejects.toThrow(/state-lifecycle/);
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(heldLeases).toBe(0);
  expect(boundary.sleep).not.toHaveBeenCalled();
});

it.each(["drain", "acquired", "native-revoked", "install-drift"] as const)(
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
    let stateHeld = false;
    let conflict = false;
    let checkedUnderBoth = false;
    let stopCustody: (() => void) | undefined;
    let capturedStopAdmission: (() => void) | undefined;
    boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
    boundary.gatewayAcquire.mockImplementation(() => {
      if (ticks < 2) {
        throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
      }
      gatewayHeld = true;
      return {
        release: () => {
          gatewayHeld = false;
        },
        createSchemaFenceDelegate: vi.fn(),
      };
    });
    boundary.stateAcquire.mockImplementation(() => {
      stateHeld = true;
      conflict = true;
      return {
        release: () => {
          stateHeld = false;
        },
      };
    });
    boundary.sleep.mockImplementation(async () => {
      ticks++;
      if (phase === "drain") {
        conflict = true;
      }
    });
    boundary.admission.mockImplementation(() => {
      checkedUnderBoth ||= gatewayHeld && stateHeld;
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
      expect(gatewayHeld || stateHeld).toBe(false);
    });
    const refusal = await begin().catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/repair admission conflict|native operation custody retired/);
    expect(refusal).not.toBeInstanceOf(DoctorMaintenanceRefusalError);
    expect(checkedUnderBoth).toBe(true);
    expect(boundary.restart).toHaveBeenCalledTimes(
      phase === "native-revoked" || phase === "install-drift" ? 0 : 1,
    );
    expect(boundary.repair).not.toHaveBeenCalled();
    expect(boundary.complete).toHaveBeenCalled();
    expect(boundary.close).not.toHaveBeenCalled();
    expect(gatewayHeld || stateHeld).toBe(false);
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
      throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
    });
    boundary.sleep.mockImplementation(async (ms: number) => {
      expect(parked).toBe(true);
      expect(boundary.restart).not.toHaveBeenCalled();
      elapsed += ms;
    });
    const stop = boundary.stop.getMockImplementation()!;
    const stopError = new Error("service stop failed after parking");
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        parked = true;
        elapsed = GATEWAY_SERVICE_STOP_TIMEOUT_MS - 1_250;
        if (stopFailed) {
          throw stopError;
        }
      }
      return result;
    });
    const refusal = await begin(() => {}).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    if (stopFailed) {
      expect(collectNestedErrorCandidates(refusal)).toContain(stopError);
    } else {
      expect(String(refusal)).toContain("gateway-lifecycle");
    }
    expect(elapsed).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
    expect(boundary.stateAcquire).not.toHaveBeenCalled();
    expect(boundary.lease).not.toHaveBeenCalled();
    expect(boundary.close).not.toHaveBeenCalled();
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledOnce();
    expect(boundary.log).toHaveBeenCalledWith(
      expect.stringMatching(/Warning:.*gateway-lifecycle.*Restoring its service/),
    );
  },
);
