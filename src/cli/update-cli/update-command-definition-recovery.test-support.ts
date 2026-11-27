import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, vi, type Mock } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as portsInspect from "../../infra/ports-inspect.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { getUpdateRun, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { renderUpdateRunSummary } from "../../infra/update-run-notice.js";
import * as processExec from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { releaseLaunchedState } from "./update-command-verification.js";

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
      if (startup === "exception" || startup === "unrelated-failure") {
        expect(
          recorded?.steps.some((step) => step.step === "installed gateway recovery admission"),
        ).toBe(false);
        expect(recorded?.origin.nextAction).toContain(
          "Your Gateway is still serving 2.0.0; nothing to restore.",
        );
        expect(recorded?.origin.nextAction).toContain("then run `openclaw update` again.");
        expect(recorded?.origin.nextAction).not.toContain("stop the Gateway");
      } else {
        expect(recorded?.origin.nextAction).toContain("openclaw update repair");
      }
      expect(recorded?.origin.nextAction).not.toMatch(/keep the gateway stopped/i);
      expect([
        recorded?.reason,
        ...(recorded?.steps.flatMap((step) => [
          step.detail,
          ...(step.failureFacts?.map((fact) => fact.message) ?? []),
        ]) ?? []),
      ]).toContainEqual(expect.stringContaining(reportedDetail));
      expect(renderUpdateRunSummary(recorded!)).toContain(reportedDetail);
    },
  );
  const answered = { serviceRunning: true, pid: 4321, port: 18789, runningVersion: "2026.9.3" };
  const stopped = { serviceRunning: false };
  const migrated = "state-migrated-no-rollback";
  // The native runtime and port listeners as read after readiness failed; the recorded
  // answer predates them.
  function useLiveRuntime(
    live: { status: "running" | "stopped"; pid?: number },
    listeners: readonly { pid?: number }[] = live.pid ? [{ pid: live.pid }] : [],
  ) {
    const resolve = vi.mocked(resolveGatewayService).getMockImplementation();
    assert(resolve);
    vi.mocked(resolveGatewayService).mockImplementation((...args) => ({
      ...resolve(...args),
      readRuntime: async () => live,
    }));
    vi.spyOn(portsInspect, "inspectPortUsage").mockImplementation(async (port) => ({
      port,
      status: "busy",
      listeners: [...listeners],
      hints: listeners.length ? [] : ["process details are unavailable"],
    }));
  }
  it.each([
    // The candidate answered as the expected version: it owns the migrated state.
    { launch: "candidate answered", outcome: "restart-health-failed", seen: [answered] },
    {
      launch: "candidate answered with its build",
      outcome: "restart-health-failed",
      seen: [{ ...answered, runningBuildId: "candidate-build" }],
      afterBuild: "candidate-build",
    },
    // The update knows the candidate's build, but the answer named none.
    {
      launch: "build not answered",
      outcome: "restart-health-failed",
      seen: [answered],
      afterBuild: "candidate-build",
      risk: true,
    },
    // The service manager accepted the restart, but no candidate process ever ran.
    { launch: "start only queued", outcome: "restart-health-failed", seen: [stopped], risk: true },
    { launch: "restart command failed", outcome: "failed", seen: [stopped], risk: true },
    // A match flag left by an earlier observation, without the candidate's own version.
    {
      launch: "stale match flag",
      outcome: "restart-health-failed",
      seen: [{ ...answered, runningVersion: "2026.9.2", versionMatch: true }],
      risk: true,
    },
    // The candidate answered, then exited while readiness was polled: the recorded answer is
    // no evidence once the service stopped.
    {
      launch: "candidate exited",
      outcome: "restart-health-failed",
      seen: [answered],
      live: { status: "stopped" },
      risk: true,
    },
    // A different process owns the port that answered; the managed PID never did.
    {
      launch: "listener not owned",
      outcome: "restart-health-failed",
      seen: [answered],
      listeners: [{ pid: 7777 }],
      risk: true,
    },
    // The managed process owns one bind address, another process owns a second one.
    {
      launch: "listener shared",
      outcome: "restart-health-failed",
      seen: [answered],
      listeners: [{ pid: 4321 }, { pid: 7777 }],
      risk: true,
    },
    // The port is busy, but its owner cannot be attributed.
    {
      launch: "listener unattributed",
      outcome: "restart-health-failed",
      seen: [answered],
      listeners: [],
      risk: true,
    },
    // Another process replaced the one that answered.
    {
      launch: "process replaced",
      outcome: "restart-health-failed",
      seen: [answered],
      live: { status: "running", pid: 9999 },
      risk: true,
    },
    // The port answered as the candidate, but no service process was identified, including
    // after the update's own Gateway recorded its PID (Gateway-triggered updates do).
    {
      launch: "no service PID",
      outcome: "restart-health-failed",
      seen: [
        { serviceRunning: true, pid: 1234, runningVersion: "2026.9.1" },
        { serviceRunning: true, pid: undefined, runningVersion: "2026.9.3" },
      ],
      risk: true,
    },
    // Same version, different build: not the candidate that migrated the state.
    {
      launch: "build mismatch",
      outcome: "restart-health-failed",
      seen: [{ ...answered, versionMatch: false }],
      risk: true,
    },
    // An unchanged or unknown version cannot tell the candidate from the build it replaced.
    {
      launch: "version unchanged",
      outcome: "restart-health-failed",
      seen: [answered],
      before: "2026.9.3",
      risk: true,
    },
    {
      launch: "previous version unknown",
      outcome: "restart-health-failed",
      seen: [answered],
      before: null,
      risk: true,
    },
  ] as const)(
    "marks a migrated restart failure at risk only without launch evidence ($launch)",
    async (row) => {
      // A retained package transaction makes rollback available, as in a package update.
      const { params } = await swappedFixture();
      params.rollbackBlockedReason = migrated;
      params.result.before = { version: "before" in row ? row.before : "2026.9.1" };
      params.result.after = {
        version: "2026.9.3",
        ...("afterBuild" in row ? { buildId: row.afterBuild } : {}),
      };
      const run = params.opts.run!;
      useLiveRuntime(
        ("live" in row ? row.live : undefined) ?? { status: "running", pid: 4321 },
        "listeners" in row ? row.listeners : undefined,
      );
      mocks.restart.mockImplementationOnce(async (restart) => {
        restart.onGatewayStartAttempted?.();
        for (const seen of row.seen) {
          recordUpdateRunVerification(run.runId, seen, { env: run.env });
        }
        restart.onVerificationFailure?.("readyz-unhealthy");
        return row.outcome;
      });
      const failed = await finish(params);
      assert(failed instanceof UpdateCommandFailure);
      const recorded = getUpdateRun(run.runId, { env: run.env });
      if ("risk" in row) {
        expect(mocks.rollback).toHaveBeenCalledOnce();
        expect(failed.result.reason).toBe(migrated);
        expectRisk(recorded?.verification.recovery, migrated);
        expect(recorded?.origin.nextAction).toContain("data at risk");
        return;
      }
      // The run still ends unsafe to restart on its own, for the true reason, with no risk.
      expect(mocks.rollback).not.toHaveBeenCalled();
      expect(failed.result.reason).toBe("readyz-unhealthy");
      expect(recorded?.verification.recovery).toEqual(unsafeRecovery());
      expect(recorded?.verification.rollbackOutcome).toEqual({
        status: "not-attempted",
        reason: migrated,
      });
      expect(recorded?.origin.nextAction).toContain("openclaw update repair");
      expect(recorded?.origin.nextAction).not.toContain("data at risk");
    },
  );
  it("keeps the migrated block for a split-root update even when the candidate answered", async () => {
    const params = fixture();
    const run = params.opts.run!;
    recordUpdateRunVerification(run.runId, answered, { env: run.env });
    useLiveRuntime({ status: "running", pid: 4321 });
    const released: FinishUpdateParams = { ...params, rollbackBlockedReason: migrated };
    await expect(
      releaseLaunchedState(released, "restart-health-failed", params.result),
    ).resolves.toBe(true);
    expect(released.rollbackBlockedReason).toBeUndefined();
    expect(getUpdateRun(run.runId, { env: run.env })?.verification.rollbackOutcome).toEqual({
      status: "not-attempted",
      reason: migrated,
    });
    const splitRoot: FinishUpdateParams = {
      ...params,
      rollbackBlockedReason: migrated,
      // Only its presence selects A's original-service compensation.
      originalManagedServiceRuntime: {} as NonNullable<
        FinishUpdateParams["originalManagedServiceRuntime"]
      >,
    };
    await expect(
      releaseLaunchedState(splitRoot, "restart-health-failed", params.result),
    ).resolves.toBe(false);
    expect(splitRoot.rollbackBlockedReason).toBe(migrated);
  });
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
