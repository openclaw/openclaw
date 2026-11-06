import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, vi, type Mock } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import * as processExec from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";

export function registerUnverifiedDefinitionRecoveryTests({
  fixture,
  makeHome,
  mocks,
}: {
  fixture: () => FinishUpdateParams;
  makeHome: () => string;
  mocks: {
    healthy: boolean;
    version: string;
    readService: Mock<typeof import("../../daemon/service.js").readGatewayServiceState>;
    revalidate: Mock;
    restartCommand: Mock<
      typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
    >;
    restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
    rollback: Mock<typeof import("./update-command-rollback.js").rollbackFailedUpdate>;
  };
}) {
  const rollbackOwner = () =>
    vi.importActual<typeof import("./update-command-rollback.js")>("./update-command-rollback.js");
  const unsafeRecovery = () => ({
    serviceRestartSafe: false as const,
    reason: "runtime-verification-failed" as const,
  });
  const expectRisk = (recovery: unknown, dataAtRisk: string) =>
    expect(recovery).toMatchObject({ serviceRestartSafe: false, dataAtRisk });
  async function swappedFixture() {
    const params = fixture();
    const { transaction, packageRoot } = await createRetainedPackageSwap(makeHome());
    params.root = params.result.root = packageRoot;
    params.packageTransaction = transaction;
    return { params, transaction, packageRoot };
  }
  async function finish(params: FinishUpdateParams) {
    const run = params.opts.run!;
    return withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(params.root);
      return finishUpdate(params).catch((error: unknown) => error);
    });
  }
  function mockService(params: FinishUpdateParams, root: string, withPid = false) {
    const env = withPid ? process.env : params.opts.run!.env!;
    const verdict = { kind: "owned" as const, root, fingerprint: "fixture" };
    params.preManagedServiceStop!.serviceUpdateVerdict = { ...verdict, refreshDefinition: withPid };
    mocks.revalidate.mockResolvedValue(withPid ? { ...verdict, refreshDefinition: true } : verdict);
    const runtime = () => ({
      status: mocks.healthy ? "running" : "stopped",
      ...(withPid && mocks.healthy ? { pid: 4321 } : {}),
    });
    vi.mocked(resolveGatewayService).mockReturnValue(
      createMockGatewayService({ readRuntime: async () => runtime() }),
    );
    mocks.readService.mockImplementation(async () => ({
      installed: true,
      loadState: { status: "loaded" },
      running: mocks.healthy,
      runtime: runtime(),
      env,
      command: {
        programArguments: [process.execPath, path.join(root, "dist/index.js"), "gateway"],
      },
    }));
  }
  const unverified = "service-definition-rollback-unverified";
  it.each([
    ["healthy", undefined, unverified],
    ["cold-start", undefined, unverified],
    ["exception", "post-update-failed", "Post-install fixture failed after activation"],
    ["start-failed", unverified, "startup fixture refused"],
    ["unrelated-failure", "update-failed", "update-failed"],
  ] as const)(
    "retains unverified definition backups and recovers the stopped installed Gateway (%s)",
    async (startup, reason, reportedDetail) => {
      const { params, transaction, packageRoot } = await swappedFixture();
      params.result.before = { version: "1.0.0" };
      params.result.after = { version: "2.0.0" };
      params.rollbackBlockedReason = undefined;
      if (startup === "unrelated-failure") {
        params.packageTransaction = undefined;
        params.result.status = "error";
        params.result.reason = "update-failed";
        params.result.recovery = unsafeRecovery();
      }
      const entrypoint = path.join(packageRoot, "dist", "index.js");
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(entrypoint, "// Synthetic installed CLI entrypoint.\n");
      mocks.version = "2.0.0";
      mockService(params, packageRoot, true);
      const native = await vi.importActual<typeof import("./update-command-service-command.js")>(
        "./update-command-service-command.js",
      );
      const runCommand = processExec.runCommandWithTimeout;
      // Native stdout is fixture I/O; executor/receiver custody has separate process proof.
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (argv[1] !== entrypoint || argv[2] !== "gateway") {
          return runCommand(argv, options);
        }
        expect(["install", "restart"]).toContain(argv[3]);
        const install = argv[3] === "install";
        if (!install) {
          expect(argv).toContain("--preserve-definition");
          mocks.healthy = startup !== "start-failed";
        }
        return createCommandResult({
          cleanup: "normal",
          code: install || ["start-failed", "cold-start"].includes(startup) ? 1 : 0,
          stdout: JSON.stringify({
            action: install ? "install" : "restart",
            ok: !install && !["start-failed", "cold-start"].includes(startup),
            ...(install
              ? {
                  error: "Installer definition backup receipt is unverified",
                  definitionBackup: { files: [] },
                }
              : startup === "cold-start"
                ? {
                    result: "restart-health-failed",
                    error: "Native 60s health wait ended while starting",
                  }
                : startup !== "start-failed"
                  ? { result: "restarted" }
                  : { error: "systemctl restart failed: startup fixture refused" }),
          }),
        });
      });
      mocks.restartCommand.mockImplementation((options, action) =>
        native.runUpdatedInstallGatewayCommand({ ...options, opts: {} }, action),
      );
      const activation = await vi.importActual<typeof import("./update-command-service.js")>(
        "./update-command-service.js",
      );
      mocks.restart.mockImplementation(async (options) => {
        const outcome = await activation.maybeRestartService(options);
        if (startup === "exception") {
          throw new Error("Post-install fixture failed after activation");
        }
        return outcome;
      });
      const rollback = await rollbackOwner();
      mocks.rollback.mockImplementation(rollback.rollbackFailedUpdate);
      const run = params.opts.run!;
      const outcome = await finish(params);
      const result = outcome instanceof UpdateCommandFailure ? outcome.result : outcome;
      const succeeded = reason === undefined;
      const healthyRecovery = { serviceRestartSafe: true, service: "healthy", version: "2.0.0" };
      expect(outcome instanceof UpdateCommandFailure).toBe(!succeeded);
      expect(result).toMatchObject({
        status: succeeded ? "ok" : "error",
        ...(succeeded ? {} : { reason }),
        ...(succeeded || ["exception", "unrelated-failure"].includes(startup)
          ? { recovery: healthyRecovery }
          : {}),
      });
      expect(mocks.restartCommand.mock.calls.map(([, action]) => action)).toEqual(
        startup === "unrelated-failure" ? ["restart"] : ["install", "restart"],
      );
      for (const [root, version] of [
        [transaction.backupRoot, "1.0.0"],
        [packageRoot, "2.0.0"],
      ] as const) {
        await expect(fs.readFile(path.join(root, "package.json"), "utf8")).resolves.toContain(
          `"version":"${version}"`,
        );
      }
      const recorded = getUpdateRun(run.runId, { env: run.env });
      expect(recorded?.status).toBe(succeeded ? "succeeded" : "failed");
      const report = renderUpdateRunReport(recorded!).markdown;
      expect(report).toContain("openclaw update repair");
      expect(report).not.toMatch(/keep the gateway stopped/i);
      expect(report).toContain(reportedDetail);
    },
  );
  it("preserves a named Doctor risk when rollback adds a generic migration refusal", async () => {
    const { params } = await swappedFixture();
    params.rollbackBlockedReason = "state-migrated-no-rollback";
    params.result.status = "error";
    params.result.reason = "post-update-failed";
    params.result.recovery = { ...unsafeRecovery(), dataAtRisk: "unreadable-state" };
    const rollback = await rollbackOwner();
    mocks.rollback.mockImplementation(rollback.rollbackFailedUpdate);
    const run = params.opts.run!;
    const outcome = await finish(params);
    assert(outcome instanceof UpdateCommandFailure);
    expectRisk(outcome.result.recovery, "unreadable-state");
    expect(mocks.restartCommand).not.toHaveBeenCalled();
    expectRisk(
      getUpdateRun(run.runId, { env: run.env })?.verification.recovery,
      "unreadable-state",
    );
  });
  it.each([undefined, "post-update-failed"])(
    "keeps the initiating failure when definition recovery is unverified (%s)",
    async (reason) => {
      const params = fixture();
      const { transaction, packageRoot } = await createRetainedPackageSwap(makeHome());
      params.result = {
        ...params.result,
        root: packageRoot,
        status: "error",
        reason,
        recovery: unsafeRecovery(),
      };
      const rollback = await rollbackOwner();
      const restore = vi.spyOn(transaction, "rollback");
      const run = params.opts.run!;
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(packageRoot);
        const outcome = await rollback.rollbackFailedUpdate({
          ...params,
          previousRoot: packageRoot,
          result: params.result,
          packageTransaction: transaction,
          rollbackBlockedReason: undefined,
          timeoutMs: params.updateStepTimeoutMs,
          definitionRecovery: { unverified: true },
        });
        expect(outcome).toMatchObject({
          rolledBack: false,
          result: {
            status: "error",
            reason: reason ?? "update-failed",
            rollbackOutcome: {
              status: "not-attempted",
              reason: "service-definition-rollback-unverified",
            },
          },
        });
      });
      expect(restore).not.toHaveBeenCalled();
      expect(mocks.restartCommand).not.toHaveBeenCalled();
    },
  );

  it("never restarts or marks migration-risk results safe during final recovery", async () => {
    for (const producer of ["migration", "inspection", "finalization"] as const) {
      mocks.healthy = false;
      const params = fixture();
      const { runId, env } = params.opts.run!;
      const root = makeHome();
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: mocks.version }),
      );
      params.root = root;
      params.result = {
        ...params.result,
        root,
        status: "error",
        reason: "doctor-failed",
        recovery: {
          serviceRestartSafe: false,
          reason:
            producer === "finalization" ? "state-migration-started" : "runtime-verification-failed",
        },
      };
      if (producer !== "finalization") {
        const inspect = vi.spyOn(stateSchemas, "readUpdateStateSchemaVersions");
        const database = path.join(env!.OPENCLAW_STATE_DIR!, "state/openclaw.sqlite");
        inspect.mockResolvedValue([{ path: database, userVersion: 2 }]);
        if (producer === "inspection") {
          inspect.mockRejectedValue(new Error("Cannot inspect migrated state"));
        }
        params.rollbackBlockedReason = await inspectActivatedUpdateState({
          result: params.result,
          root,
          schemaVersions: [{ path: database, userVersion: 1 }],
          config: {},
          env: env!,
        });
        inspect.mockRestore();
      }
      mockService(params, root);
      mocks.restartCommand.mockImplementation(async () => {
        mocks.healthy = true;
        return "accepted";
      });
      // Native activation would make this runnable package healthy; the risk must prevent it.
      const failure = await finish(params);
      assert(failure instanceof UpdateCommandFailure);
      const risk =
        producer === "inspection" ? "rollback-state-unverified" : "state-migrated-no-rollback";
      const actions = mocks.restartCommand.mock.calls.map(([, action]) => action);
      expect(failure.result, JSON.stringify({ producer, actions })).toMatchObject({
        reason: risk,
        recovery: { serviceRestartSafe: false, dataAtRisk: risk },
      });
      if (producer !== "finalization") {
        expectRisk(params.result.recovery, risk);
      }
      expect(actions, producer).toEqual([]);
      expect(mocks.restart.mock.calls.length, producer).toBe(0);
      const persisted = getUpdateRun(runId, { env });
      expectRisk(persisted?.verification.recovery, risk);
      expect(persisted?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:data-at-risk",
          failureFacts: [{ check: "update-recovery", code: risk }],
        }),
      );
    }
  });
}
