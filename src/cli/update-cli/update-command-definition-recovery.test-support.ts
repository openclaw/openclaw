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
import { defaultRuntime } from "../../runtime.js";
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
  it.each(["healthy", "cold-start", "exception", "start-failed", "unrelated-failure"])(
    "retains unverified definition backups and recovers the stopped installed Gateway (%s)",
    async (startup) => {
      const params = fixture();
      const { transaction, packageRoot } = await createRetainedPackageSwap(makeHome());
      params.root = params.result.root = packageRoot;
      params.result.before = { version: "1.0.0" };
      params.result.after = { version: "2.0.0" };
      params.packageTransaction = transaction;
      params.rollbackBlockedReason = undefined;
      if (startup === "unrelated-failure") {
        params.packageTransaction = undefined;
        params.result.status = "error";
        params.result.reason = "update-failed";
        params.result.recovery = {
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        };
      }
      params.preManagedServiceStop!.serviceUpdateVerdict = {
        kind: "owned",
        root: packageRoot,
        fingerprint: "fixture",
        refreshDefinition: true,
      };
      const entrypoint = path.join(packageRoot, "dist", "index.js");
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(entrypoint, "// Synthetic installed CLI entrypoint.\n");
      mocks.version = "2.0.0";
      const service = createMockGatewayService({
        readRuntime: async () => ({
          status: mocks.healthy ? "running" : "stopped",
          ...(mocks.healthy ? { pid: 4321 } : {}),
        }),
      });
      vi.mocked(resolveGatewayService).mockReturnValue(service);
      mocks.readService.mockImplementation(async () => ({
        installed: true,
        loadState: { status: "loaded" },
        running: mocks.healthy,
        runtime: {
          status: mocks.healthy ? "running" : "stopped",
          ...(mocks.healthy ? { pid: 4321 } : {}),
        },
        env: process.env,
        command: {
          programArguments: [
            process.execPath,
            path.join(packageRoot, "dist", "index.js"),
            "gateway",
          ],
        },
      }));
      mocks.revalidate.mockResolvedValue({
        kind: "owned",
        root: packageRoot,
        fingerprint: "fixture",
        refreshDefinition: true,
      });
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
          stdout: JSON.stringify(
            install
              ? {
                  action: "install",
                  ok: false,
                  error: "Installer definition backup receipt is unverified",
                  definitionBackup: { files: [] },
                }
              : startup === "cold-start"
                ? {
                    action: "restart",
                    ok: false,
                    result: "restart-health-failed",
                    error: "Native 60s health wait ended while starting",
                  }
                : startup !== "start-failed"
                  ? { action: "restart", ok: true, result: "restarted" }
                  : {
                      action: "restart",
                      ok: false,
                      error: "systemctl restart failed: startup fixture refused",
                    },
          ),
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
      const rollback = await vi.importActual<typeof import("./update-command-rollback.js")>(
        "./update-command-rollback.js",
      );
      mocks.rollback.mockImplementation(rollback.rollbackFailedUpdate);
      const complete = vi.spyOn(transaction, "complete");
      const restore = vi.spyOn(transaction, "rollback");
      const run = params.opts.run!;
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(packageRoot);
        const outcome = await finishUpdate(params).catch((error: unknown) => error);
        const result = outcome instanceof UpdateCommandFailure ? outcome.result : outcome;
        if (["healthy", "cold-start"].includes(startup)) {
          expect(
            outcome,
            JSON.stringify({ result, errors: vi.mocked(defaultRuntime.error).mock.calls }),
          ).not.toBeInstanceOf(UpdateCommandFailure);
          expect(result).toMatchObject({
            status: "ok",
            recovery: { serviceRestartSafe: true, service: "healthy", version: "2.0.0" },
          });
        } else {
          expect(outcome).toBeInstanceOf(UpdateCommandFailure);
          expect(result).toMatchObject({
            status: "error",
            reason:
              startup === "exception"
                ? "post-update-failed"
                : startup === "unrelated-failure"
                  ? "update-failed"
                  : "service-definition-rollback-unverified",
            ...(["exception", "unrelated-failure"].includes(startup)
              ? { recovery: { serviceRestartSafe: true, service: "healthy", version: "2.0.0" } }
              : {}),
          });
        }
      });
      expect(mocks.restartCommand.mock.calls.map(([, action]) => action)).toEqual(
        startup === "unrelated-failure" ? ["restart"] : ["install", "restart"],
      );
      expect(restore).not.toHaveBeenCalled();
      if (startup === "unrelated-failure") {
        expect(complete).not.toHaveBeenCalled();
      } else {
        expect(complete).toHaveBeenCalledExactlyOnceWith(
          { activationVerified: false },
          expect.any(Function),
        );
      }
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      const recorded = getUpdateRun(run.runId, { env: run.env });
      expect(recorded?.status).toBe(
        ["healthy", "cold-start"].includes(startup) ? "succeeded" : "failed",
      );
      const report = renderUpdateRunReport(recorded!).markdown;
      expect(report).toContain("openclaw update repair");
      expect(report).not.toMatch(/keep the gateway stopped/i);
      expect(report).toContain(
        startup === "exception"
          ? "Post-install fixture failed after activation"
          : startup === "start-failed"
            ? "startup fixture refused"
            : ["healthy", "cold-start"].includes(startup)
              ? "service-definition-rollback-unverified"
              : "update-failed",
      );
    },
  );
  it("preserves a named Doctor risk when rollback adds a generic migration refusal", async () => {
    const params = fixture();
    const { transaction, packageRoot } = await createRetainedPackageSwap(makeHome());
    params.root = params.result.root = packageRoot;
    params.packageTransaction = transaction;
    params.rollbackBlockedReason = "state-migrated-no-rollback";
    params.result.status = "error";
    params.result.reason = "post-update-failed";
    params.result.recovery = {
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
      dataAtRisk: "unreadable-state",
    };
    const rollback = await vi.importActual<typeof import("./update-command-rollback.js")>(
      "./update-command-rollback.js",
    );
    mocks.rollback.mockImplementation(rollback.rollbackFailedUpdate);
    const run = params.opts.run!;
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(packageRoot);
      const outcome = await finishUpdate(params).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(UpdateCommandFailure);
      if (!(outcome instanceof UpdateCommandFailure)) {
        throw new Error("Expected update failure");
      }
      expect(outcome.result.recovery).toMatchObject({
        serviceRestartSafe: false,
        dataAtRisk: "unreadable-state",
      });
    });
    expect(mocks.restartCommand).not.toHaveBeenCalled();
    expect(getUpdateRun(run.runId, { env: run.env })?.verification.recovery).toMatchObject({
      serviceRestartSafe: false,
      dataAtRisk: "unreadable-state",
    });
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
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      };
      const rollback = await vi.importActual<typeof import("./update-command-rollback.js")>(
        "./update-command-rollback.js",
      );
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
        const database = path.join(
          params.opts.run!.env!.OPENCLAW_STATE_DIR!,
          "state/openclaw.sqlite",
        );
        inspect.mockResolvedValue([{ path: database, userVersion: 2 }]);
        if (producer === "inspection") {
          inspect.mockRejectedValue(new Error("Cannot inspect migrated state"));
        }
        params.rollbackBlockedReason = await inspectActivatedUpdateState({
          result: params.result,
          root,
          schemaVersions: [{ path: database, userVersion: 1 }],
          config: {},
          env: params.opts.run!.env!,
        });
        inspect.mockRestore();
      }
      mocks.readService.mockImplementation(async () => ({
        installed: true,
        loadState: { status: "loaded" },
        running: mocks.healthy,
        runtime: { status: mocks.healthy ? "running" : "stopped" },
        env: params.opts.run!.env!,
        command: {
          programArguments: [process.execPath, path.join(root, "dist/index.js"), "gateway"],
        },
      }));
      vi.mocked(resolveGatewayService).mockReturnValue(
        createMockGatewayService({
          readRuntime: async () => ({ status: mocks.healthy ? "running" : "stopped" }),
        }),
      );
      mocks.revalidate.mockResolvedValue({ kind: "owned", root, fingerprint: "fixture" });
      params.preManagedServiceStop!.serviceUpdateVerdict = {
        kind: "owned",
        root,
        fingerprint: "fixture",
        refreshDefinition: false,
      };
      mocks.restartCommand.mockImplementation(async () => {
        mocks.healthy = true;
        return "accepted";
      });
      // Native activation would make this runnable package healthy; the risk must prevent it.
      const run = params.opts.run!;
      const failure = await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(root);
        return await finishUpdate(params).catch((error: unknown) => error);
      });
      assert(failure instanceof UpdateCommandFailure);
      const risk =
        producer === "inspection" ? "rollback-state-unverified" : "state-migrated-no-rollback";
      const actions = mocks.restartCommand.mock.calls.map(([, action]) => action);
      expect(failure.result, JSON.stringify({ producer, actions })).toMatchObject({
        reason: risk,
        recovery: { serviceRestartSafe: false, dataAtRisk: risk },
      });
      if (producer !== "finalization") {
        expect(params.result.recovery).toMatchObject({
          serviceRestartSafe: false,
          dataAtRisk: risk,
        });
      }
      expect(actions, producer).toEqual([]);
      expect(mocks.restart.mock.calls.length, producer).toBe(0);
      const persisted = getUpdateRun(params.opts.run!.runId, { env: params.opts.run!.env });
      expect(persisted?.verification.recovery).toMatchObject({
        serviceRestartSafe: false,
        dataAtRisk: risk,
      });
      expect(persisted?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:data-at-risk",
          failureFacts: [{ check: "update-recovery", code: risk }],
        }),
      );
    }
  });
}
