import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import * as candidateState from "../infra/update-candidate-state.js";
import type { UpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import * as assert from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import { candidateStartupStep as startupStep } from "./update-cli-lifecycle.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { pluginSyncResult } from "./update-cli/update-cli-config.test-support.js";
import { recoveryVerificationStep } from "./update-cli/update-cli-failure-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const setup = createUpdateCliFixture();
  const { updateCommand, ExitError } = update;

  async function expectPackageVersion(root: string, version: string) {
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version,
    });
  }

  function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0) {
    return assert.requireValue(mock.mock.invocationCallOrder[index], "expected call order");
  }
  async function runningPackage(prefix: string, node = process.execPath) {
    const root = await setup.mockPackageInstallAtCaseDir(prefix);
    setup.mockFileBackedPathExists();
    setup.mockRunningManagedGateway([node, path.join(root, "dist", "index.js"), "gateway", "run"]);
    return root;
  }
  async function stoppedPackage(
    platform: NodeJS.Platform,
    prefix: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const dir = setup.tempDirs.make(prefix);
    const installed = await setup.setupInstalledPackageRoot(dir);
    setup.primeServiceCommand(
      [nodeExecutable, installed.entryPath, "gateway", "run"],
      env,
      env?.OPENCLAW_SERVICE_MARKER && platform === "win32"
        ? resolveGatewayTaskScriptPath(process.env)
        : undefined,
    );
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    setup.mockFileBackedPathExists();
    return { ...installed, platformSpy };
  }

  it.each(["config-change", "legacy-config-change", "invalid"] as const)(
    "validates the staged candidate without inference while the previous gateway serves (%s)",
    async (outcome) => {
      const valid = outcome !== "invalid";
      const legacyConfigChange = outcome === "legacy-config-change";
      const { nodeModules, pkgRoot, entryPath } = await setup.setupInstalledPackageAtNodeModules(
        path.join(setup.tempDirs.make("openclaw-update-candidate-order-"), "lib", "node_modules"),
        "1.0.0",
      );
      setup.mockNpmGlobalRoot(nodeModules);
      setup.mockFileBackedPathExists();
      setup.mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      const doctorChanges: UpdateDoctorConfigChange[] = [
        { kind: "key", key: "meta" },
        { kind: "key", key: "plugins" },
        { kind: "key", key: "wizard" },
        { kind: "migration", message: "Enabled the configured provider plugin." },
      ];
      if (outcome === "config-change") {
        const readGenerations = candidateState.readUpdateDatabaseGenerationsIsolated;
        // The dummy installed package has no workers; retain real reads in the harness runtime.
        vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated").mockImplementation(
          (paths, options) => readGenerations(paths, { ...options, root: undefined }),
        );
        const runCommand = assert.requireValue(
          vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
          "configured updater commands",
        );
        vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) => {
          if (argv.at(-1) === "--doctor") {
            const env = typeof options === "number" ? undefined : options.env;
            const resultPath = assert.requireValue(
              env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
              "Doctor receipt path",
            );
            await writeUpdatePostInstallDoctorResult({
              resultPath,
              result: { status: "ok", configChanges: doctorChanges },
            });
          }
          return runCommand(argv, options);
        });
      }
      const events: string[] = [];
      mocks.spawn.mockImplementationOnce((_node, _argv, options: { env: NodeJS.ProcessEnv }) => {
        const resultPath = options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        if (!resultPath) {
          throw new Error("post-core result path missing");
        }
        const childResultPath = `${resultPath}.child`;
        const child = new EventEmitter();
        queueMicrotask(() => {
          void withEnvAsync(
            {
              OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
              ...options.env,
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: childResultPath,
            },
            async () => {
              const { resumePostCoreUpdate } =
                await import("./update-cli/update-command-resume.js");
              await resumePostCoreUpdate({
                root: pkgRoot,
                channel: "stable",
                opts: { yes: true, json: true },
                timeoutMs: 30_000,
              });
            },
          )
            .then(async () => {
              // Restore the emulated child's environment before the parent can read its receipt.
              await fs.rename(childResultPath, resultPath);
              child.emit("exit", 0, null);
              child.emit("close", 0, null);
            })
            .catch((error: unknown) => {
              child.emit("error", error);
              child.emit("close", 1, null);
            });
        });
        return child;
      });
      let candidateRoot: string | undefined;
      mocks.candidateValidation.mockImplementation(async (options) => {
        const { root } = options;
        candidateRoot = root;
        events.push("validate");
        expect(mocks.serviceStop).not.toHaveBeenCalled();
        expect(await mocks.serviceReadRuntime()).toMatchObject({ status: "running" });
        expect(root).not.toBe(pkgRoot);
        await expectPackageVersion(root, "9999.0.0");
        await expectPackageVersion(pkgRoot, "1.0.0");
        return setup.reportCandidateSteps(options, {
          status: valid ? "ok" : "error",
          durationMs: 1,
          logTail: ["candidate readiness failed"],
          reason: "runtime-verification-failed",
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          doctorConfigWrites: outcome === "config-change",
          ...(legacyConfigChange || outcome === "config-change"
            ? { doctorConfigChanges: doctorChanges }
            : {}),
          steps: [startupStep(root, valid)],
        });
      });
      mocks.serviceStop.mockImplementationOnce(async () => {
        events.push("stop");
        await expectPackageVersion(pkgRoot, "1.0.0");
        mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      });
      mocks.syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) => {
        events.push("plugins");
        expect(await mocks.serviceReadRuntime()).toMatchObject({ status: "stopped" });
        return pluginSyncResult(config);
      });

      if (valid) {
        await updateCommand({ yes: true, json: true });
        expect(events).toEqual(["validate", "stop", "plugins"]);
        expect(mocks.spawn).toHaveBeenCalledOnce();
        expect(update.runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entryPath, "config", "validate", "--json"],
          expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
        );
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        const result = assert.lastWriteJsonCall() as UpdateRunResult;
        expect(result.status).toBe("ok");
        expect(
          update.getUpdateRun(assert.requireValue(result.runId, "updated run id")),
        ).toMatchObject({
          status: "succeeded",
          downtimeMs: expect.any(Number),
          verification: { readyz: true, serviceRunning: true },
        });
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(events).toEqual(["validate"]);
        assert.expectNoSideEffects(mocks.serviceStop, mocks.serviceStart, mocks.serviceRestart);
        expect(assert.freshRestartCalls()).toHaveLength(0);
        await expectPackageVersion(pkgRoot, "1.0.0");
        expect(assert.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "runtime-verification-failed",
        });
        await expect(
          fs.access(assert.requireValue(candidateRoot, "candidate root")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const result = assert.lastWriteJsonCall() as UpdateRunResult;
      const record = update.getUpdateRun(assert.requireValue(result.runId, "run id"));
      expect(mocks.inferenceRepair).not.toHaveBeenCalled();
      expect(record?.repair).toEqual([]);
      expect(record?.steps.some((step) => step.step === "repairing")).toBe(false);
      if (outcome === "config-change") {
        expect(record?.reason).toBeNull();
        expect(
          record?.steps.flatMap((step) => (step.configChange ? [step.configChange] : [])),
        ).toEqual(doctorChanges);
      }
      if (legacyConfigChange) {
        const warning =
          "Doctor changed config keys meta, plugins, wizard during update checks. Check those settings after the update; this version cannot verify that they were applied.";
        expect(record?.steps).toContainEqual(
          expect.objectContaining({
            step: expect.stringMatching(/^warning:/),
            status: "completed",
            detail: warning,
          }),
        );
        expect(renderUpdateRunReport(assert.requireValue(record, "update run")).lines).toContain(
          `Warning: ${warning}`,
        );
        expect(assert.doctorCommandCall()).toBeDefined();
      }
    },
  );

  it.each(["owned-running", "no-restart"] as const)(
    "uses compatibility-checked package update without full-state startup (%s)",
    async (mode) => {
      await runningPackage("openclaw-update-startup-admission");
      await update
        .invokeUpdateCli({
          yes: true,
          json: true,
          restart: mode !== "no-restart",
        })
        .catch(() => {});
      expect(mocks.candidateValidation).toHaveBeenCalled();
      expect(assert.doctorCommandCall()).toBeDefined();
      expect(await fs.readdir(path.dirname(setup.profileStateDir()))).not.toContain(
        `.${path.basename(setup.profileStateDir())}-update-checkpoints`,
      );
    },
  );

  it("keeps the live package unchanged when its executor is rebound during candidate validation", async () => {
    const root = await setup.mockPackageInstallAtCaseDir("openclaw-update-revoked-executor");
    setup.mockFileBackedPathExists();
    const before = await fs.readFile(path.join(root, "package.json"));
    mocks.candidateValidation.mockImplementationOnce(async (options) => {
      const { createManagedHandoffLeaseStore } =
        await import("../infra/update-managed-service-handoff-lease.js");
      const store = createManagedHandoffLeaseStore();
      const found = store.read(resolveUpdateInstallRoot(root));
      if (found.kind !== "current") {
        throw new Error("Expected the real startup executor before candidate validation");
      }
      await Promise.resolve();
      expect(store.bind(found.lease, process.pid)).not.toBeNull();
      return setup.reportCandidateSteps(options, {
        status: "ok",
        steps: [startupStep(options.root)],
      });
    });
    await expect(updateCommand({ yes: true, json: true })).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "package.json"))).toEqual(before);
    expect(assert.doctorCommandCall()).toBeUndefined();
    assert.expectNoSideEffects(mocks.serviceStop, mocks.serviceRestart);
  });

  it("refuses activation when successful Doctor leaves the validated candidate schema unapplied", async () => {
    const root = await setup.mockPackageInstallAtCaseDir("openclaw-update-incomplete-migration");
    setup.mockFileBackedPathExists();
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(root, "dist", "index.js"),
    );
    mocks.candidateValidation.mockImplementationOnce(async (options) =>
      setup.reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [startupStep(root)],
      }),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(assert.doctorCommandCall()).toBeDefined();
    assert.expectNoSideEffects(mocks.serviceStart, mocks.serviceRestart, update.runDaemonRestart);
    expect(assert.freshRestartCalls()).toEqual([]);
    expect(assert.lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "openclaw doctor",
      steps: expect.arrayContaining([
        expect.objectContaining({
          exitCode: 1,
          stderrTail: expect.stringContaining(String(OPENCLAW_STATE_SCHEMA_VERSION + 1)),
        }),
      ]),
    });
  });

  it("stages and validates before suspending and stopping a running managed gateway", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    using processOnSpy = vi.spyOn(process, "on");
    using processOffSpy = vi.spyOn(process, "off");
    mocks.suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    mocks.resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await runningPackage("openclaw-update-stop-service", nodeExecutable);
    vi.mocked(update.resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockResolvedValue(path.join(root, "dist", "index.js"));
    mocks.serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "fixture",
    });
    await updateCommand({ yes: true });
    platformSpy.mockRestore();

    const doctorCall = assert.doctorCommandCall();
    expect(doctorCall).toBeDefined();
    expect(doctorCall?.[1].env).toMatchObject({
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    });
    expect(assert.getLogOutput()).toContain("Gateway: restarted and verified.");
    const npmInstallCallIndex = assert
      .commandCalls()
      .findIndex(([argv]) => argv[0] === "npm" && argv[1] === "i");
    const serviceStopCall = mocks.serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env).toMatchObject({
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    const suspendOrder = callOrder(mocks.suspendScheduledTaskAutoStartForUpdate);
    const sigintListenerIndex = processOnSpy.mock.calls.findIndex(([event]) => event === "SIGINT");
    for (const action of [
      mocks.suspendScheduledTaskAutoStartForUpdate,
      mocks.resumeScheduledTaskAutoStartAfterUpdate,
    ]) {
      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        }),
        expect.objectContaining({ beforeMutation: expect.any(Function) }),
      );
    }
    expect(callOrder(processOnSpy, sigintListenerIndex)).toBeLessThan(suspendOrder);
    expect(suspendOrder).toBeLessThan(callOrder(mocks.serviceStop));
    const validationOrder = callOrder(mocks.candidateValidation);
    expect(callOrder(vi.mocked(update.runCommandWithTimeout), npmInstallCallIndex)).toBeLessThan(
      validationOrder,
    );
    expect(validationOrder).toBeLessThan(suspendOrder);
    expect(callOrder(mocks.serviceStop)).toBeLessThan(
      callOrder(mocks.resumeScheduledTaskAutoStartAfterUpdate),
    );
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
      expect(processOnSpy).toHaveBeenCalledWith(signal, expect.any(Function));
      expect(processOffSpy).toHaveBeenCalledWith(signal, expect.any(Function));
    }
  });

  it.each([
    { platform: "darwin" as const, handoff: undefined },
    { platform: "win32" as const, handoff: "1" },
  ])(
    "quiesces a stopped loaded managed gateway on $platform before package replacement",
    async ({ platform, handoff }) => {
      const { nodeModules, platformSpy } = await stoppedPackage(
        platform,
        `openclaw-update-stopped-loaded-${platform}-`,
        { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      );
      using _ = platformSpy;
      setup.mockNpmGlobalRoot(nodeModules);
      const stopStarted = createDeferredCore();
      const stopFinished = createDeferredCore();
      mocks.serviceStop.mockImplementationOnce(() => {
        stopStarted.resolve();
        return stopFinished.promise;
      });

      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
        const updatePromise = updateCommand({ yes: true });
        const firstOutcome = await Promise.race([
          stopStarted.promise.then(() => "stop" as const),
          updatePromise.then(() => "update" as const),
        ]);

        expect(firstOutcome).toBe("stop");
        expect(mocks.serviceStop).toHaveBeenCalledOnce();
        expect(assert.packageInstallCommandCall()).toBeDefined();
        expect(mocks.candidateValidation).toHaveBeenCalledOnce();
        await expectPackageVersion(path.join(nodeModules, "openclaw"), "2026.4.21");
        const pluginRecordCallsBeforeStop =
          mocks.loadInstalledPluginIndexInstallRecords.mock.calls.length;
        stopFinished.resolve();
        await updatePromise;
        expect(mocks.loadInstalledPluginIndexInstallRecords.mock.calls.length).toBeGreaterThan(
          pluginRecordCallsBeforeStop,
        );
      });

      expect(assert.packageInstallCommandCall()).toBeDefined();
      expect(mocks.loadInstalledPluginIndexInstallRecords).toHaveBeenCalled();
      expect(mocks.serviceStop.mock.invocationCallOrder[0]).toBeLessThan(
        assert.requireValue(
          mocks.loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder.at(-1),
          "owned managed update context capture order",
        ),
      );
    },
  );

  it("leaves an ordinary stopped Scheduled Task stopped during package replacement", async () => {
    const { nodeModules, platformSpy } = await stoppedPackage(
      "win32",
      "openclaw-update-stopped-win32-",
    );
    using _ = platformSpy;
    setup.mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, () =>
      updateCommand({ yes: true }),
    );

    assert.expectNoSideEffects(mocks.serviceStop, mocks.serviceRestart);
    expect(assert.packageInstallCommandCall()).toBeDefined();
  });

  it("leaves an enabled LaunchAgent untouched when staged installation fails", async () => {
    const { nodeModules, platformSpy } = await stoppedPackage(
      "darwin",
      "openclaw-update-stopped-launchagent-failure-",
      { OPENCLAW_STATE_DIR: setup.profileStateDir() },
    );
    using _ = platformSpy;
    setup.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        throw new Error("package replacement failed");
      }
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
      await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));
    });

    assert.expectNoSideEffects(mocks.serviceStop, mocks.serviceStart, mocks.serviceRestart);
    expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(assert.freshRestartCalls()).toEqual([]);

    expect(assert.packageInstallCommandCall()?.[0]).toContain("--prefix");
  });

  it.each([false, true])(
    "attempts recovery after Git mutation throws and preserves failed readiness (json=%s)",
    async (json) => {
      setup.mockStoppedManagedGitGateway();
      setup.setTty(true);
      setup.setStdoutTty(true);
      const cause = new Error(
        json ? "The pipe is being closed (0x800700e8)" : "ENOSPC while replacing runtime files",
      );
      const failure = new Error(
        json
          ? `SQLite read-only worker failed to start for state.sqlite: ${cause.message}`
          : `updater interrupted after mutation: ${"replacement verification detail; ".repeat(12)}`,
        { cause },
      );
      vi.mocked(update.updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
        await assert.requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        mocks.restartHealthTestControl.snapshot = {
          runtime: { status: "stopped", pid: null, state: "stopped" },
          portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
          healthy: false,
          staleGatewayPids: [],
          waitOutcome: "timeout",
          probeError: "Gateway remains stopped after interrupted mutation.",
        };
        throw failure;
      });

      await expect(
        withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, () => updateCommand({ json })),
      ).rejects.toEqual(new ExitError(1));
      expect(mocks.serviceStop).toHaveBeenCalledOnce();
      expect(assert.freshRestartCalls()).toHaveLength(1);
      assert.expectNoSideEffects(mocks.serviceStart, mocks.serviceRestart);
      expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
      expect(mocks.triageCommand).toHaveBeenCalledTimes(json ? 0 : 1);
      const reportedFailure = json
        ? { result: assert.lastWriteJsonCall() }
        : mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
      expect(reportedFailure).toMatchObject({
        result: {
          status: "error",
          mode: "git",
          reason: "update-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          verification: { serviceRunning: false, readyz: false, settled: false },
          steps: [
            expect.objectContaining({ name: "updater-runtime-retention", exitCode: 0 }),
            expect.objectContaining({ exitCode: 1, stderrTail: formatErrorMessage(failure) }),
            expect.objectContaining({ name: "post-stop-checks", exitCode: 0 }),
            recoveryVerificationStep([
              {
                check: "gateway-recovery",
                code: "gateway-probe-failed",
                message:
                  "Failed to restart managed gateway service after failed update: Error: Service runtime: status=stopped, state=stopped",
              },
            ]),
          ],
        },
      });
      expect(assert.getLogOutput()).not.toMatch(/keep the gateway stopped/i);
      expect(assert.getLogOutput()).toContain("openclaw update repair");
      if (!json) {
        const recovery = expectDefined(
          mocks.triageCommand.mock.calls[0]?.[1]?.recovery,
          "captured failed-update recovery",
        );
        const diagnostic = sanitizeTriageUpdateFailure(recovery.updateFailure, {
          env: {},
          stateDir: setup.profileStateDir(),
        });
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining("updater interrupted after mutation"),
        });
        expect(diagnostic.error).toContain(cause.message);
      }
    },
  );
});
