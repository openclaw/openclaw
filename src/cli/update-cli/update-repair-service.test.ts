// Keep repair admission, finalization, and the run ledger real.
import "./update-repair.test-support.js";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as serviceApi from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as portsProbe from "../../infra/ports-probe.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as dataAtRisk from "../../infra/update-data-at-risk.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createManagedHandoffRecoveryFixture } from "../../infra/update-managed-service-handoff-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as registryListing from "../../state/openclaw-agent-db-registry-listing.js";
import * as databasePreflight from "../../state/openclaw-database-preflight.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import * as probeApi from "../daemon-cli/restart-health-probe.js";
import * as healthApi from "../daemon-cli/restart-health.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { createUpdateServiceStateReader } from "./update-command-service-state.test-support.js";

const { createRepairState, mocks } = await import("./update-repair.test-support.js");
vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));

let state: OpenClawTestState;
let service: ReturnType<typeof createMockGatewayService>;
let events: string[];
beforeEach(async () => {
  state = await createRepairState("repair-service");
  mockSystemAccountHome();
  events = [];
  await fs.writeFile(
    state.path("package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  await fs.writeFile(state.path("openclaw.mjs"), "// synthetic Gateway entrypoint\n");
  const control = state.path("handoff-control");
  await fs.mkdir(control);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  service = createMockGatewayService({
    readCommand: vi.fn(async () => ({
      programArguments: [process.execPath, state.path("openclaw.mjs"), "gateway"],
      sourcePath: state.path("gateway.service"),
    })),
    start: vi.fn(async (args) => {
      await args.beforeMutation?.();
      args.assertCurrent?.();
      events.push("start");
    }),
  });
  vi.spyOn(serviceApi, "resolveGatewayService").mockReturnValue(service);
  vi.spyOn(serviceApi, "readGatewayServiceState").mockImplementation(
    createUpdateServiceStateReader({
      readCommand: service.readCommand,
      isLoaded: service.isLoaded,
      readRuntime: service.readRuntime,
      readCapability: async () => ({ kind: "writable" }),
      absentPort: () => 19789,
    }),
  );
  vi.spyOn(healthApi, "waitForGatewayHealthyRestart").mockImplementation(async () => {
    events.push("verified");
    return {
      outcome: "ready",
      runtime: { status: "running", pid: 4242 },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      healthy: true,
      staleGatewayPids: [],
      gatewayVersion: "1.0.0",
    };
  });
  vi.spyOn(healthApi, "waitForGatewayHttpReadiness").mockResolvedValue({
    healthz: 200,
    readyz: 200,
  });
  mocks.convergence.mockImplementation(async ({ pluginUpdate }) => {
    events.push("finalized");
    const { readConfigFileSnapshot } = await import("../../config/config.js");
    return {
      pluginUpdate,
      configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

function failedHealth(
  status: "stopped" | "running",
): Awaited<ReturnType<typeof healthApi.waitForGatewayHealthyRestart>> {
  const stopped = status === "stopped";
  return {
    outcome: "failed",
    waitOutcome: stopped ? "stopped-free" : "timeout",
    runtime: stopped ? { status } : { status, pid: 4242 },
    portUsage: { port: 18789, status: stopped ? "free" : "busy", listeners: [], hints: [] },
    healthy: false,
    staleGatewayPids: [],
  };
}

function seed(
  stopped: boolean,
  verification = {},
  nativeStop = false,
  restarted = false,
  reason = "managed-service-handoff-failed",
) {
  const run = createUpdateRun({
    trigger: "control-ui",
    ...(nativeStop ? { target: { installationMethod: "npm-global" } } : {}),
  });
  if (nativeStop) {
    recordUpdateRunStep(run.runId, {
      step: "managed-service update handoff",
      status: "completed",
      endedAtMs: Date.now(),
    });
    recordUpdateRunPhase(run.runId, "activating");
  }
  if (stopped && !nativeStop) {
    recordUpdateRunStep(run.runId, {
      step: "service-stop",
      status: "completed",
      endedAtMs: Date.now(),
    });
  }
  recordUpdateRunVerification(run.runId, verification);
  if (restarted) {
    recordUpdateRunStep(run.runId, {
      step: "managed-service-restart",
      status: "completed",
      endedAtMs: Date.now(),
    });
  }
  finishUpdateRun(run.runId, { status: "failed", reason });
  return run.runId;
}
function repair(json = true) {
  return withCliProcessScope(() =>
    runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--timeout", "15", ...(json ? ["--json"] : [])],
    }),
  );
}

it.each(["unavailable", "absent"] as const)(
  "completes repair with manual guidance for an %s Gateway service",
  async (kind) => {
    seed(true);
    const finalize = mocks.convergence.getMockImplementation()!;
    mocks.convergence.mockImplementation(async (...args) => {
      const result = await finalize(...args);
      // The service disappears after maintenance, before restoration inspects it.
      vi.mocked(service.readCommand).mockResolvedValue(null);
      if (kind === "absent") {
        vi.mocked(service.isLoaded).mockResolvedValue(false);
        vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped", missingUnit: true });
        vi.spyOn(portsProbe, "probePortUsage").mockResolvedValue("free");
      }
      return result;
    });
    await repair();
    expect(listUpdateRuns()[0]?.status).toBe("succeeded");
    expect(events).toEqual(["finalized"]);
    expect(service.start).not.toHaveBeenCalled();
    expect(healthApi.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        restart: false,
        postUpdate: expect.objectContaining({
          doctor: expect.objectContaining({
            warnings: [expect.stringContaining("openclaw gateway start")],
          }),
        }),
      }),
    );
  },
);

it("finalizes an interrupted managed update, then starts and verifies its stopped Gateway", async () => {
  const original = seed(true);
  await repair();
  expect(events).toEqual(["finalized", "start", "verified"]);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "ok",
      restart: true,
      verification: expect.objectContaining({ serviceRunning: true, settled: true }),
    }),
  );
  for (const run of [getUpdateRun(original)!, listUpdateRuns()[0]!]) {
    expect(run.verification).toMatchObject({ serviceRunning: true, settled: true, pid: 4242 });
  }
  expect(listUpdateRuns()[0]?.steps).toContainEqual(
    expect.objectContaining({ step: "finalize:gatewayRestoration", status: "completed" }),
  );
  expect(defaultRuntime.error).not.toHaveBeenCalledWith(
    expect.stringContaining("openclaw gateway start"),
  );
  await repair(false);
  expect(service.start).toHaveBeenCalledTimes(1);
});

it.each(["recorded native handoff", "legacy activating phase"])(
  "restores an updater-stopped Gateway after both owners die with %s",
  async (evidence) => {
    await fs.rmdir(state.path("handoff-control"));
    const handoff = createManagedHandoffRecoveryFixture(state.root);
    handoff.seed({ ageMs: 1_000 });
    const original = createUpdateRun({
      trigger: "control-ui",
      target: {
        installationMethod:
          evidence === "recorded native handoff" ? "npm-global" : "managed-service",
      },
    });
    recordUpdateRunVerification(original.runId, {
      serviceRunning: true,
      runningVersion: "1.0.0",
    });
    recordUpdateRunPhase(original.runId, "activating");
    if (evidence === "recorded native handoff") {
      recordUpdateRunStep(original.runId, {
        step: "managed-service update handoff",
        status: "completed",
        endedAtMs: Date.now(),
      });
    }
    finishUpdateRun(original.runId, { status: "failed", reason: "abandoned" });
    handoff.facts.runIds = [original.runId];

    await repair();

    expect(handoff.store.read(state.root)).toEqual({ kind: "absent" });
    expect(events).toEqual(["finalized", "start", "verified"]);
    expect(getUpdateRun(original.runId)?.verification).toMatchObject({
      serviceRunning: true,
      settled: true,
      runningVersion: "1.0.0",
    });
    expect(listUpdateRuns()[0]?.status).toBe("succeeded");
  },
);

it.each([
  "operator stop",
  "successful restart",
  "recorded running Gateway",
  "completed managed restart",
  "later settled run",
])("does not start a Gateway after %s", async (reason) => {
  seed(
    reason !== "operator stop",
    reason === "successful restart"
      ? { serviceRunning: true, settled: true }
      : reason === "recorded running Gateway"
        ? { serviceRunning: true }
        : {},
    reason !== "operator stop",
    reason === "completed managed restart",
  );
  if (reason === "later settled run") {
    const later = createUpdateRun({ trigger: "cli" });
    recordUpdateRunVerification(later.runId, { serviceRunning: true, settled: true });
    finishUpdateRun(later.runId, { status: "succeeded" });
  }
  await repair();
  expect(service.start).not.toHaveBeenCalled();
  expect(healthApi.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
  if (["operator stop", "successful restart", "later settled run"].includes(reason)) {
    // No pending update-owned stop: Doctor maintenance owns the stopped-service report.
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ restart: false }),
    );
    return;
  }
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      restart: false,
      status: "warning",
      postUpdate: expect.objectContaining({
        doctor: expect.objectContaining({
          warnings: [expect.stringContaining("openclaw gateway start")],
        }),
      }),
    }),
  );
});

const markedRisk = {
  recovery: {
    serviceRestartSafe: false,
    reason: "state-migration-started",
    dataAtRisk: "rollback-state-unverified",
  },
} as const;

it.each(["stopped", "running"] as const)(
  "verifies a recorded data-at-risk mark against current state and restores the %s Gateway",
  async (gateway) => {
    const original = seed(true, markedRisk);
    if (gateway === "running") {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
    }

    await repair(false);

    expect(events).toEqual(
      gateway === "stopped" ? ["finalized", "start", "verified"] : ["finalized", "verified"],
    );
    const repairRun = listUpdateRuns()[0]!;
    expect(repairRun.status).toBe("succeeded");
    expect(repairRun.steps).toContainEqual(
      expect.objectContaining({
        step: `finalize:data-at-risk-verified:${original}`,
        status: "completed",
      }),
    );
    // History is not rewritten: the original run keeps its recorded mark.
    expect(getUpdateRun(original)?.verification.recovery).toMatchObject({
      dataAtRisk: "rollback-state-unverified",
    });
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      `Update ${original} recorded data at risk (rollback-state-unverified); verification found the state schemas match installed OpenClaw ${VERSION} and no migration or restore is unfinished, so that mark is resolved.`,
    );
  },
);

it("verifies a mark on an update that never stopped the Gateway without starting it", async () => {
  // A Git release update or a refusal before mutation leaves the Gateway serving.
  const original = seed(false, markedRisk);
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
  // Repair's healthy-Gateway shortcut must not reach a real local Gateway.
  vi.spyOn(probeApi, "confirmGatewayReachable").mockResolvedValue({
    reachable: false,
    gatewayVersion: null,
    gatewayBuildId: undefined,
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  });

  await repair(false);

  expect(service.start).not.toHaveBeenCalled();
  const repairRun = listUpdateRuns()[0]!;
  expect(repairRun.status).toBe("succeeded");
  expect(repairRun.steps).toContainEqual(
    expect.objectContaining({
      step: `finalize:data-at-risk-verified:${original}`,
      status: "completed",
    }),
  );
  expect(defaultRuntime.log).toHaveBeenCalledWith(
    expect.stringContaining(
      `Update ${original} recorded data at risk (rollback-state-unverified); verification found`,
    ),
  );
  // The receipt resolves the mark: a later repair has nothing left to verify.
  vi.mocked(defaultRuntime.log).mockClear();
  await repair(false);
  expect(defaultRuntime.log).not.toHaveBeenCalledWith(
    expect.stringContaining("recorded data at risk"),
  );
});

// Refusals happen before Doctor runs, so Doctor never parks or restarts the Gateway.
function expectRefusedBeforeDoctor(refusal: string) {
  expect(mocks.doctor).not.toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
  expect(service.stop).not.toHaveBeenCalled();
  expect(healthApi.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(refusal));
  const repairRun = listUpdateRuns()[0]!;
  expect(repairRun.status).toBe("failed");
  expect(
    repairRun.steps.some((step) => step.step.startsWith("finalize:data-at-risk-verified:")),
  ).toBe(false);
}

it.each([
  {
    status: "inconsistent",
    // A realistic path and writer: the next steps lead, so a length cap keeps them.
    detail:
      "the state database /Users/alice/.openclaw/state/openclaw.sqlite is at schema 41 (written by OpenClaw 2026.11.9), newer than 40 supported by installed OpenClaw 2026.11.6",
    nextAction:
      "run `openclaw update` to a version that supports it, or restore the pre-update backup.",
    finding: "Found:",
  },
  {
    status: "unverifiable",
    detail: "the state databases could not be inspected: database is locked",
    nextAction: "retry `openclaw update repair` once that reason is cleared.",
    finding: "Could not verify:",
  },
] as const)(
  "keeps the Gateway as it was when a recorded mark is $status",
  async ({ finding, ...verification }) => {
    const original = seed(true, markedRisk);
    vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency").mockResolvedValue(verification);

    await repair();

    expectRefusedBeforeDoctor(
      `Update ${original} recorded data at risk (rollback-state-unverified). The Gateway is stopped. Repair left the Gateway as it was. ${triageLead}${verification.nextAction} ${finding} ${verification.detail}.`,
    );
  },
);

it("keeps a Gateway another update stopped down when a later mark is inconsistent", async () => {
  // The stopping run carries no mark; a later Git release or pre-mutation run does.
  seed(true);
  const marked = seed(false, markedRisk, false, false, "rollback-state-unverified");
  vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency").mockResolvedValue({
    status: "inconsistent",
    detail: "the state database is at schema 39 behind a leftover rollback",
    nextAction: "keep that file and the backup.",
  });

  await repair();

  expectRefusedBeforeDoctor(`Update ${marked} recorded data at risk`);
});

it("lets Doctor finish an unfinished migration before the mark is checked again", async () => {
  const original = seed(true, markedRisk);
  const verify = vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency");
  verify.mockResolvedValueOnce({
    status: "inconsistent",
    finishable: true,
    detail: "the state database is at schema 39",
    nextAction: "run `openclaw doctor --fix` to finish the migration.",
  });

  await repair(false);

  // Doctor ran, then the second check found the migrated state consistent.
  expect(mocks.doctor).toHaveBeenCalled();
  expect(verify).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["finalized", "start", "verified"]);
  expect(listUpdateRuns()[0]?.steps).toContainEqual(
    expect.objectContaining({ step: `finalize:data-at-risk-verified:${original}` }),
  );
});

it("fails repair and leaves recovery open when the mark is still refused after Doctor", async () => {
  const original = seed(true, markedRisk);
  const behind = {
    status: "inconsistent",
    finishable: true,
    detail: "the state database is at schema 39",
    nextAction: "run `openclaw doctor --fix` to finish the migration.",
  } as const;
  vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency")
    .mockResolvedValueOnce(behind)
    .mockResolvedValueOnce({ ...behind, detail: "the state database is still at schema 39" });

  await repair();

  expect(mocks.doctor).toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
  expect(listUpdateRuns()[0]?.status).toBe("failed");
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    // Doctor's maintenance may have parked and restored it, so no "left as it was" claim.
    expect.stringContaining(
      "Repair did not start or restart the Gateway after this check. Run `openclaw triage`",
    ),
  );
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("Found: the state database is still at schema 39."),
  );
  // Recovery stays open: once the state is consistent, the next repair starts the Gateway.
  await repair(false);
  expect(events).toEqual(["finalized", "finalized", "start", "verified"]);
  expect(listUpdateRuns()[0]?.steps).toContainEqual(
    expect.objectContaining({ step: `finalize:data-at-risk-verified:${original}` }),
  );
});

it("refuses before Doctor when an unfinished migration comes with unchecked agent leftovers", async () => {
  const original = seed(true, markedRisk);
  // The agent registry cannot be read, so rollback leftovers beside agent databases are unknown.
  vi.spyOn(registryListing, "readRegisteredAgentDatabases").mockImplementation(() => {
    throw new Error("registry locked");
  });
  const preflight = databasePreflight.preflightOpenClawDatabaseSchemas;
  vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas").mockImplementation(
    async (params, purpose) =>
      purpose === "runtime" && params?.preserveSourceArtifacts === false
        ? {
            incompatible: [],
            indeterminate: [],
            pendingMigrations: [
              {
                kind: "state",
                path: "/state/openclaw.sqlite",
                foundVersion: 39,
                supportedVersion: 40,
              },
            ],
          }
        : await preflight(params, purpose),
  );

  await repair();

  expectRefusedBeforeDoctor(
    `Update ${original} recorded data at risk (rollback-state-unverified). The Gateway is stopped. Repair left the Gateway as it was. ${triageLead}retry \`openclaw update repair\` once that reason is cleared. Then: run \`openclaw doctor --fix\` to finish the migration. Could not verify: the agent database registry could not be read, so database rollback leftovers beside agent databases are unchecked; and the state database /state/openclaw.sqlite is at schema 39;`,
  );
});

it("resolves a live-writer mark once Doctor has held the state, without a second repair", async () => {
  const original = seed(true, {
    recovery: { ...markedRisk.recovery, dataAtRisk: "active-mutation" },
  });
  const verify = vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency");

  await repair(false);

  // Before Doctor the mark is deferred to it; after Doctor's exclusive admission the
  // writers it named cannot hold the state, so the schema check decides.
  expect(mocks.doctor).toHaveBeenCalled();
  expect(verify.mock.calls.map(([params]) => params.writersExcluded)).toEqual([undefined, true]);
  expect(events).toEqual(["finalized", "start", "verified"]);
  expect(listUpdateRuns()[0]?.steps).toContainEqual(
    expect.objectContaining({ step: `finalize:data-at-risk-verified:${original}` }),
  );
});

it("reports a serving Gateway as running when a recorded mark is inconsistent", async () => {
  const original = seed(false, markedRisk);
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
  // The guidance probe must not reach a real local Gateway.
  vi.spyOn(probeApi, "confirmGatewayReachable").mockResolvedValue({
    reachable: true,
    gatewayVersion: "1.0.0",
    gatewayBuildId: undefined,
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  });
  vi.spyOn(dataAtRisk, "verifyUpdateStateConsistency").mockResolvedValue({
    status: "inconsistent",
    newerState: true,
    detail: "the state database is at schema 99",
    nextAction:
      "run `openclaw update` to a version that supports it, or restore the pre-update backup.",
  });

  await repair();

  expectRefusedBeforeDoctor(
    `Update ${original} recorded data at risk (rollback-state-unverified). The Gateway is running and serving OpenClaw 1.0.0. Repair left the Gateway as it was. ${triageLead}run \`openclaw update\` to a version that supports it, or restore the pre-update backup. Found: the state database is at schema 99.`,
  );
});

const triageLead = "Run `openclaw triage` for an agent with the recorded facts, or by hand: ";

// #188303: a refused recovery after migrated state leaves the managed service stopped
// (launchd boots it out); without named data risk, repair restarts it on the installed package.
it("restarts a Gateway left stopped by a refused post-migration recovery", async () => {
  seed(
    true,
    { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } },
    true,
    false,
    "state-migrated-no-rollback",
  );
  await repair();
  expect(events).toEqual(["finalized", "start", "verified"]);
});

it("verifies a handoff that recorded manager liveness without settled readiness", async () => {
  const original = seed(true, { serviceRunning: true });
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
  await repair();
  expect(service.start).not.toHaveBeenCalled();
  expect(getUpdateRun(original)?.verification).toMatchObject({
    serviceRunning: true,
    settled: true,
  });
});

it.each(["thrown", "stopped"])(
  "preserves an operator stop after observing a running Gateway with %s readiness",
  async (failure) => {
    seed(true);
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
    if (failure === "thrown") {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockRejectedValueOnce(
        new Error("readiness deadline exceeded"),
      );
    } else {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValueOnce(
        failedHealth("stopped"),
      );
    }
    await repair();
    expect(listUpdateRuns()[0]?.status).toBe("failed");
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped" });
    await repair();
    expect(service.start).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ restart: false }),
    );
  },
);

it("keeps the Gateway stopped when finalization fails", async () => {
  seed(true);
  mocks.convergence.mockRejectedValue(new Error("plugin convergence failed"));
  await repair();
  expect(service.start).not.toHaveBeenCalled();
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("plugin convergence failed"),
  );
  expect(listUpdateRuns()[0]?.status).toBe("failed");
});

it("does not start the Gateway while a helper still owns its installation", async () => {
  seed(true);
  const store = createManagedHandoffLeaseStore();
  const acquired = store.acquire(state.root, "live-helper", { kind: "update" });
  expect(acquired.kind).toBe("acquired");
  await repair();
  expect(service.start).not.toHaveBeenCalled();
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("Another update executor owns this installation"),
  );
  if (acquired.kind === "acquired") {
    expect(store.release(acquired.lease)).toBe(true);
  }
});

it.each(["start failure", "unverified health"])(
  "reports %s with the deep status command",
  async (reason) => {
    seed(true);
    if (reason === "start failure") {
      vi.mocked(service.start).mockRejectedValue(new Error("native start failed"));
    }
    vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValue(failedHealth("stopped"));
    await repair();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw gateway status --deep"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw gateway start"),
    );
    expect(listUpdateRuns()[0]?.status).toBe("failed");
  },
);

it.each([
  { status: "running", failure: "returned" },
  { status: "running", failure: "thrown" },
  { status: "operator-stopped", failure: "returned" },
  { status: "operator-stopped", failure: "thrown" },
] as const)(
  "repairs $failure readiness failure with the $status Gateway without starting it again",
  async ({ status, failure }) => {
    const original = seed(true);
    if (failure === "thrown") {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockRejectedValueOnce(
        new Error("readiness deadline exceeded"),
      );
    } else {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValueOnce(
        failedHealth("running"),
      );
    }
    await repair();
    expect(listUpdateRuns()[0]?.status).toBe("failed");
    if (status === "running") {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
    } else {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValue(failedHealth("stopped"));
    }
    await repair();
    expect(service.start).toHaveBeenCalledTimes(1);
    if (status === "running") {
      // Failure recovery after the first repair already verified the serving Gateway.
      expect(listUpdateRuns().some((run) => run.verification.settled === true)).toBe(true);
    } else {
      expect(getUpdateRun(original)?.verification.settled).not.toBe(true);
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ restart: false }),
      );
      await repair();
      expect(service.start).toHaveBeenCalledTimes(1);
    }
  },
);
