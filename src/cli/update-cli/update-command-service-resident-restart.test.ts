// Update Doctor's predecessor stop against a Gateway that restarts itself for the
// replaced installation: real maintenance stop, real drain, and boot records written
// by the Gateway's own lifecycle operations and read back through the real reader.
// The service manager, its host-specific systemd helpers and the Gateway connection
// are simulated.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import type { CallGatewayCliOptions } from "../../gateway/call.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import { gatewayBootOperations } from "../../infra/gateway-boot-lifecycle.worker.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import { stopSupervisedPredecessorGateway } from "../../infra/update-candidate-predecessor-stop.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { gatewayCommand, gatewayHello } from "./update-command-service-fixtures.test-support.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  call: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/service-process-membership.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service-process-membership.js")>()),
  inspectServiceProcessMembershipSync: () => "outside",
}));
vi.mock("../../daemon/systemd-maintenance.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-maintenance.js")>()),
  prepareSystemdGatewayMaintenance: async () => ({ kind: "unchanged" }),
}));
vi.mock("../../daemon/systemd-stop-policy.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-stop-policy.js")>()),
  readSystemdGatewayStopTimeout: async () => 330_000,
}));
vi.mock("../../gateway/call.js", async (original) => ({
  ...(await original<typeof import("../../gateway/call.js")>()),
  callGatewayCli: mocks.call,
}));
vi.mock("../../gateway/local-http-probe.js", async (original) => ({
  ...(await original<typeof import("../../gateway/local-http-probe.js")>()),
  createConfiguredGatewayLocalProbe: () => ({
    resolveWebSocketTarget: async () => ({ url: "ws://127.0.0.1:18789" }),
  }),
}));
// mock-isolation: the drain uses explicit fixture credentials, independent of device storage.
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: { token: "fixture-token" } }),
}));

const REPLACED =
  "gateway.installation_replaced: Installation replaced: running 1 build a; on-disk 2 build b.";
const firstPid = Math.max(process.pid, process.ppid) + 1;
const successorPid = firstPid + 1;

beforeEach(() => {
  mockSystemAccountHome();
  mockProcessPlatform("linux");
  // The simulated service must not be judged by the test host's native ancestry.
  vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  });
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  mocks.call.mockReset();
  mocks.service.mockReset();
  vi.restoreAllMocks();
});

type Restart = "before the resident answers" | "after the resident answers";
type Recorded =
  | "installation replacement"
  | "operator stop"
  | "installation replacement by an earlier process";

/**
 * One managed Gateway service whose process is replaced once, at the drain's
 * first resident observation: either the predecessor is already gone (the
 * successor answers) or it answers and exits before the native stop.
 */
async function runPredecessorStop(
  home: string,
  restart: Restart,
  recorded: Recorded,
  successor: "stays" | "has a changed definition" | "restarts again" = "stays",
) {
  const env = { ...process.env };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  // The Gateway's lifecycle operations, run on this file's private state database.
  const state = openOpenClawStateDatabase({ env });
  const lifecycle = { open: () => state, stateOptions: () => ({ path: state.path, env }) };
  const beginBoot = (pid: number) => {
    // The operation records its own process; each simulated Gateway is a distinct one.
    const ownPid = vi.spyOn(process, "pid", "get").mockReturnValue(pid);
    try {
      return expectDefined(
        gatewayBootOperations["gatewayBoot.begin"](Date.now(), lifecycle).id,
        "Gateway boot was not recorded",
      );
    } finally {
      ownPid.mockRestore();
    }
  };
  const completeBoot = (bootId: string, completion: GatewayBootLifecycleCompletion) =>
    gatewayBootOperations["gatewayBoot.complete"](
      { bootId, completion, nowMs: Date.now(), countSignalStops: false },
      lifecycle,
    );
  if (recorded === "installation replacement by an earlier process") {
    // The predecessor's own predecessor restarted for a replacement; the predecessor
    // itself then dies without a record.
    completeBoot(beginBoot(firstPid - 1), { outcome: "planned_restart", reason: REPLACED });
  }
  const predecessorBoot = beginBoot(firstPid);
  let resident = { pid: firstPid, bootId: "predecessor-boot" };
  let restarted = false;
  const restartGateway = () => {
    restarted = true;
    if (recorded === "installation replacement") {
      completeBoot(predecessorBoot, { outcome: "planned_restart", reason: REPLACED });
    } else if (recorded === "operator stop") {
      completeBoot(predecessorBoot, { outcome: "clean_stop", reason: "stop (SIGTERM)" });
    }
    beginBoot(successorPid);
    resident = { pid: successorPid, bootId: "successor-boot" };
  };
  let statusCalls = 0;
  const stop = vi.fn<GatewayService["stop"]>(async ({ onMutation }) => {
    onMutation?.({ mode: "systemctl-stop" });
  });
  mocks.service.mockReturnValue(
    createMockGatewayService({
      readCommand: async () => {
        const command = gatewayCommand(home);
        return restarted && successor === "has a changed definition"
          ? { ...command, environment: { ...command.environment, OPENCLAW_PROFILE: "other" } }
          : command;
      },
      readRuntime: async () => ({
        status: "running",
        pid: resident.pid,
        systemd: { managerUid: 2001 },
      }),
      isLoaded: async () => true,
      stop,
    }),
  );
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    if (!restarted && restart === "before the resident answers") {
      restartGateway();
    }
    const answering = resident;
    request.onHelloOk?.(gatewayHello(answering.bootId));
    request.assertDispatchCurrent?.();
    if (request.method === "status") {
      if (!restarted) {
        restartGateway();
      } else if (++statusCalls === 2 && successor === "restarts again") {
        // The second drain's first observation: the successor is replaced in turn.
        resident = { pid: successorPid + 1, bootId: "second-successor-boot" };
        return { pid: resident.pid, shutdownBudget: { timeoutMs: 325_000 } };
      }
      return { pid: answering.pid, shutdownBudget: { timeoutMs: 325_000 } };
    }
    if (request.method === "system.info") {
      return { pid: answering.pid, processInstanceId: answering.bootId };
    }
    throw new Error(`Unexpected Gateway method: ${request.method}`);
  });
  const warn = vi.fn<(message: string) => void>();
  const outcome = await withEnvAsync({ [UPDATE_RUN_ID_ENV]: run.runId }, () =>
    stopSupervisedPredecessorGateway(
      { runId: run.runId, repair: true },
      { root: process.cwd(), assertCurrent: () => {}, warn },
    ).catch((error: unknown) => error),
  );
  return { outcome, stop, warn, steps: getUpdateRun(run.runId, { env })?.steps ?? [] };
}

it.each<Restart>(["before the resident answers", "after the resident answers"])(
  "stops the Gateway that restarted itself for the replaced installation %s",
  (restart) =>
    withServiceHome(async (home) => {
      const result = await runPredecessorStop(home, restart, "installation replacement");
      expect(result.outcome).toBe(true);
      expect(result.stop).toHaveBeenCalledOnce();
      // The stop receipt names the process that was stopped, not the one that exited.
      expect(
        result.steps
          .filter((step) => step.step.startsWith("finalize:predecessor-stop:"))
          .map((step) => step.step.split(":")[4]),
      ).toEqual([String(successorPid)]);
      const warning = expect.stringContaining("restarted itself for the replaced installation");
      expect(result.warn).toHaveBeenCalledWith(warning);
      expect(
        result.steps.filter((step) => step.step.startsWith("warning:gateway-maintenance:")),
      ).toEqual([expect.objectContaining({ status: "completed", detail: warning })]);
    }),
);

it.each(
  (["before the resident answers", "after the resident answers"] as const).flatMap((restart) =>
    (["operator stop", "installation replacement by an earlier process"] as const).map(
      (recorded) => ({
        restart,
        recorded,
      }),
    ),
  ),
)(
  "refuses a Gateway process that changed $restart with only an $recorded on record",
  ({ restart, recorded }) =>
    withServiceHome(async (home) => {
      const result = await runPredecessorStop(home, restart, recorded);
      expect(String(result.outcome)).toContain("Gateway process changed during maintenance drain");
      expect(result.stop).not.toHaveBeenCalled();
      expect(result.warn).not.toHaveBeenCalled();
      // Neither a stop receipt nor a maintenance warning reaches update history.
      expect(result.steps.map((step) => step.step)).toEqual(["requested"]);
    }),
);

it("refuses the restarted Gateway when its service definition changed with it", () =>
  withServiceHome(async (home) => {
    const result = await runPredecessorStop(
      home,
      "before the resident answers",
      "installation replacement",
      "has a changed definition",
    );
    // The re-inspection revalidates the service; no warning step shows it stopped there.
    expect(String(result.outcome)).toContain("service-ownership-changed");
    expect(result.stop).not.toHaveBeenCalled();
    expect(result.steps.map((step) => step.step)).toEqual(["requested"]);
  }));

it("refuses a second process change after the accepted restart", () =>
  withServiceHome(async (home) => {
    const result = await runPredecessorStop(
      home,
      "before the resident answers",
      "installation replacement",
      "restarts again",
    );
    expect(String(result.outcome)).toContain("Gateway process changed during maintenance drain");
    expect(result.stop).not.toHaveBeenCalled();
    expect(result.warn).toHaveBeenCalledOnce();
    expect(
      result.steps.filter((step) => step.step.startsWith("finalize:predecessor-stop:")),
    ).toEqual([]);
  }));
