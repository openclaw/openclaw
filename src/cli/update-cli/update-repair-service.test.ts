// Keep repair admission, finalization, and the run ledger real.
import "./update-repair.test-support.js";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as serviceApi from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
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
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
  "named data risk",
])("does not start a Gateway after %s", async (reason) => {
  seed(
    reason !== "operator stop",
    reason === "named data risk"
      ? {
          recovery: {
            serviceRestartSafe: false,
            reason: "state-migration-started",
            dataAtRisk: "session migration is incomplete",
          },
        }
      : reason === "successful restart"
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
          warnings: [
            expect.stringContaining(
              reason === "named data risk"
                ? "Gateway remains stopped: session migration is incomplete"
                : "openclaw gateway start",
            ),
          ],
        }),
      }),
    }),
  );
});

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
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValueOnce({
        outcome: "failed",
        runtime: { status: "stopped" },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
      });
    }
    await repair();
    expect(listUpdateRuns()[0]?.status).toBe("failed");
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped" });
    await repair();
    expect(service.start).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "warning", restart: false }),
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
    vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValue({
      outcome: "failed",
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
    });
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
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValueOnce({
        outcome: "failed",
        runtime: { status: "running", pid: 4242 },
        portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
      });
    }
    await repair();
    expect(listUpdateRuns()[0]?.status).toBe("failed");
    if (status === "running") {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid: 4242 });
    } else {
      vi.mocked(healthApi.waitForGatewayHealthyRestart).mockResolvedValue({
        outcome: "failed",
        runtime: { status: "stopped" },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
      });
    }
    await repair();
    expect(service.start).toHaveBeenCalledTimes(1);
    if (status === "running") {
      expect(getUpdateRun(original)?.verification.settled).toBe(true);
    } else {
      expect(getUpdateRun(original)?.verification.settled).not.toBe(true);
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "warning", restart: false }),
      );
      await repair();
      expect(service.start).toHaveBeenCalledTimes(1);
    }
  },
);
