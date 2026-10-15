import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
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
      const started = path.join(packageRoot, "started");
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        `
        import fs from 'node:fs';
        const install = process.argv.includes('install');
        if (!install && ${JSON.stringify(startup)} !== 'start-failed') fs.writeFileSync(${JSON.stringify(started)}, 'running');
        process.stdout.write(JSON.stringify(install
          ? { action: 'install', ok: false, error: 'Installer definition backup receipt is unverified', definitionBackup: { files: [] } }
          : ${JSON.stringify(startup)} === 'cold-start'
            ? { action: 'restart', ok: false, result: 'restart-health-failed', error: 'Native 60s health wait ended while starting' }
            : ${JSON.stringify(startup)} !== 'start-failed'
            ? { action: 'restart', ok: true, result: 'restarted' }
            : { action: 'restart', ok: false, error: 'systemctl restart failed: startup fixture refused' }));
        process.exitCode = install || ['start-failed', 'cold-start'].includes(${JSON.stringify(startup)}) ? 1 : 0;
      `,
      );
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
      // Native command I/O is a synthetic executable; executor/receiver custody has its own process proof.
      mocks.restartCommand.mockImplementation(async (options, action) => {
        try {
          return await native.runUpdatedInstallGatewayCommand({ ...options, opts: {} }, action);
        } finally {
          mocks.healthy = await fs.readFile(started, "utf8").then(
            () => true,
            () => false,
          );
        }
      });
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
}
