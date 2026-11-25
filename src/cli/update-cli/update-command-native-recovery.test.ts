import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { resultFixture, verificationFixture } from "./update-command-fixtures.test-support.js";
import { finishSuccessfulPackageSwitch } from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";
import * as recoveryService from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  restart: vi.fn(),
  health: vi.fn(),
  owned: (root: string) => ({
    kind: "owned" as const,
    root,
    fingerprint: "original",
    refreshDefinition: false,
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.state,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: async ({ root }: { root: string }) =>
    mocks.owned(root),
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restart,
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
}));
const fixture = useExecutorFixture("native-recovery-owner-");
const recoverable = { serviceRestartSafe: true as const, version: "1.0.0" };
function createOwner(stateAtRoot = false) {
  const { root, control } = fixture();
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateAtRoot ? root : path.join(root, "state") };
  const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
  const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env };
  return { root, control, env, runId, run };
}

it.each([
  "healthy",
  "lost at health",
  "refusal",
  "missing executor",
  "ordinary",
  "revoked at service",
  "revoked at health",
  "release refused",
] as const)(
  "recovers under the original executor without converting authority loss to health: %s",
  async (scenario) => {
    vi.clearAllMocks();
    const { root, control, env, runId, run } = createOwner();
    const onGatewayStartAttempted = vi.fn();
    const opts = {
      onGatewayStartAttempted,
      jsonMode: true,
      updateRun: scenario === "ordinary" ? undefined : run,
      preManagedServiceStop: {
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: true,
        serviceEnv: env,
        serviceUpdateVerdict: mocks.owned(root),
      },
      recovery: { ...recoverable },
    } satisfies Parameters<typeof maybeRestartServiceAfterFailedMutableUpdate>[0];
    const changeRow = () => {
      using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
      if (scenario === "release refused") {
        db.exec(
          "CREATE TRIGGER refuse_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(ABORT, 'test release refused'); END",
        );
      } else {
        const changed = db
          .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
          .run("replacement", root);
        expect(changed.changes).toBe(1);
      }
    };
    mocks.state.mockImplementation(async () => {
      if (scenario === "revoked at service") {
        changeRow();
      }
      return { env, command: { environment: env } };
    });
    mocks.health.mockImplementation(async () => {
      if (scenario === "revoked at health" || scenario === "release refused") {
        changeRow();
      }
      if (scenario === "lost at health") {
        run.executorFence = undefined;
      }
      return { healthy: true, runtime: { status: "running" } };
    });
    mocks.restart.mockImplementation(async (params) => {
      params.onGatewayStartAttempted?.();
      if (opts.updateRun) {
        params.assertCurrent();
      }
      if (scenario === "refusal") {
        throw new UpdateCommandRecoveryPendingError("receiver refused");
      }
      return "accepted";
    });
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      if (scenario !== "missing executor") {
        run.executorFence = fence;
      }
      const recovery = maybeRestartServiceAfterFailedMutableUpdate(opts);
      if (scenario === "healthy" || scenario === "ordinary" || scenario === "release refused") {
        await expect(recovery).resolves.toBe("healthy");
      } else {
        await expect(recovery).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
        if (scenario === "missing executor") {
          expect(mocks.state).not.toHaveBeenCalled();
          expect(mocks.restart).not.toHaveBeenCalled();
        }
      }
    });
    if (scenario.startsWith("revoked") || scenario === "release refused") {
      if (scenario === "release refused") {
        await expect(work).rejects.toThrow("test release refused");
      } else {
        await expect(work).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
      }
      const row = createManagedHandoffLeaseStore().read(root);
      expect(row.kind).toBe("current");
      if (scenario.startsWith("revoked")) {
        expect(row.kind === "current" && row.lease.owner).toBe("replacement");
      }
      if (scenario === "revoked at service") {
        expect(mocks.restart).not.toHaveBeenCalled();
        expect(mocks.health).not.toHaveBeenCalled();
      }
    } else {
      await work;
      expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    }
    expect(onGatewayStartAttempted).toHaveBeenCalledTimes(
      scenario === "missing executor" || scenario === "revoked at service" ? 0 : 1,
    );
    expect(getUpdateRun(runId, { env })?.status).toBe("running");
  },
);

it("retains the live update run while recovering a failed update before reporting", async () => {
  const { root: home, env, runId, run } = createOwner(true);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  await fs.writeFile(path.join(home, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const verification = await vi.importActual<typeof import("./update-command-verification.js")>(
    "./update-command-verification.js",
  );
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(verification.verifyUpdatedGateway);
  vi.spyOn(
    await import("./update-command-readiness.js"),
    "observeUpdateGatewayReadiness",
  ).mockImplementationOnce(async (params) => {
    params.assertCurrent?.();
    expect(params.expectedVersion).toBe("1.0.0");
    expect(getUpdateRun(runId, { env })?.status).toBe("running");
    return {
      health: {
        healthy: true,
        runtime: { status: "running", pid: 4242 },
        gatewayVersion: "1.0.0",
        expectedVersion: "1.0.0",
        portUsage: { port: params.gatewayPort, status: "busy", listeners: [], hints: [] },
        staleGatewayPids: [],
      },
      readyz: true,
      http: undefined,
      launchAgentRecovery: null,
    };
  });
  const service = gatewayService.resolveGatewayService();
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
    ...service,
    readRuntime: async () => ({ status: "stopped" }),
  });
  let recoveryRun: typeof run | undefined;
  vi.spyOn(recoveryService, "maybeRestartServiceAfterFailedMutableUpdate").mockImplementation(
    async (request) => {
      recoveryRun = request.updateRun;
      recoveryRun?.executorFence?.assertCurrent();
      return "healthy";
    },
  );
  await withUpdateCommandExecutor(runId, async (executor) => {
    run.executorFence = await executor.enter(home);
    await expect(
      finishSuccessfulPackageSwitch(
        { packageRoot: home, restartEnvironment: env, run },
        {
          mutationStarted: false,
          result: resultFixture(home, {
            status: "error",
            reason: "fixture-install-failed",
            recovery: { ...recoverable },
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandFailure",
      result: { reason: "fixture-install-failed", recovery: { service: "healthy" } },
    });
    expect(recoveryRun).toBe(run);
    const recorded = getUpdateRun(runId, { env });
    expect(recorded?.verification).toEqual({
      ...verificationFixture("1.0.0"),
      pid: 4242,
      port: 18789,
      recovery: { ...recoverable, service: "healthy" },
    });
    expect(recorded?.steps.filter((step) => step.step === "gateway recovery verification")).toEqual(
      [{ step: "gateway recovery verification", status: "completed", exitCode: 0 }],
    );
  });
});
