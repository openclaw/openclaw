import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { UpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  commandCalls,
  doctorCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  candidateValidation,
  inferenceRepair,
  loadInstalledPluginIndexInstallRecords,
  restartHealthTestControl,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceDefinitionMutationCapability,
  serviceEnabled,
  serviceLoaded,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  spawn,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  triageCommand,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  getUpdateRun,
  invokeUpdateCli,
  readConfigFileSnapshot,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import { pluginSyncResult } from "./update-cli/update-cli-config.test-support.js";
import { recoveryVerificationStep } from "./update-cli/update-cli-failure-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    configSnapshot,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockPackageInstallAtCaseDir,
    mockPackageReplacementFailure,
    mockRunningManagedGateway,
    mockStoppedManagedGitGateway,
    primeServiceCommand,
    profileStateDir,
    reportCandidateSteps,
    setStdoutTty,
    setTty,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    tempDirs,
  } = createUpdateCliFixture();

  it.each([
    "valid",
    "config-change",
    "legacy-config-change",
    "live-config-change",
    "invalid",
  ] as const)(
    "validates the staged candidate without inference while the previous gateway serves (%s)",
    async (outcome) => {
      const valid = outcome !== "invalid";
      const legacyConfigChange = outcome === "legacy-config-change";
      const succeeds = valid && outcome !== "live-config-change";
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        path.join(tempDirs.make("openclaw-update-candidate-order-"), "lib", "node_modules"),
        "1.0.0",
      );
      mockNpmGlobalRoot(nodeModules);
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      const doctorChanges: UpdateDoctorConfigChange[] = [
        { kind: "key", key: "meta" },
        { kind: "key", key: "plugins" },
        { kind: "key", key: "wizard" },
        { kind: "migration", message: "Enabled the configured provider plugin." },
      ];
      if (outcome === "config-change") {
        const runCommand = requireValue(
          vi.mocked(runCommandWithTimeout).getMockImplementation(),
          "configured updater commands",
        );
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
          if (argv.at(-1) === "--doctor") {
            const env = typeof options === "number" ? undefined : options.env;
            const resultPath = requireValue(
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
      let liveConfigPath: string | undefined;
      if (outcome === "live-config-change") {
        liveConfigPath = path.join(tempDirs.make("openclaw-update-live-config-"), "openclaw.json");
        await fs.writeFile(liveConfigPath, "{}\n");
        vi.mocked(readConfigFileSnapshot).mockImplementation(async () => {
          const configPath = requireValue(liveConfigPath, "live config path");
          const raw = await fs.readFile(configPath, "utf8");
          return configSnapshot(JSON.parse(raw) as OpenClawConfig, {
            path: configPath,
            raw,
            hash: createHash("sha256").update(raw).digest("hex"),
          });
        });
      }
      const events: string[] = [];
      spawn.mockImplementationOnce((_node, _argv, options: { env: NodeJS.ProcessEnv }) => {
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
              // Real child environments cannot overlap the parent. Restore this
              // emulated child before its result lets the parent resume.
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
      candidateValidation.mockImplementation(async (options) => {
        const { root } = options;
        candidateRoot = root;
        events.push("validate");
        expect(serviceStop).not.toHaveBeenCalled();
        expect(await serviceReadRuntime()).toMatchObject({ status: "running" });
        expect(root).not.toBe(pkgRoot);
        expect(
          JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
        ).toMatchObject({
          version: "9999.0.0",
        });
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        if (outcome === "live-config-change") {
          await fs.writeFile(
            requireValue(liveConfigPath, "live config path"),
            JSON.stringify({ logging: { level: "debug" } }),
          );
        }
        return reportCandidateSteps(options, {
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
          steps: [
            {
              name: "candidate-gateway-startup",
              command: "openclaw gateway",
              cwd: root,
              durationMs: 1,
              exitCode: valid ? 0 : 1,
              ...(!valid ? { stderrTail: "candidate readiness failed" } : {}),
            },
          ],
        });
      });
      serviceStop.mockImplementationOnce(async () => {
        events.push("stop");
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      });
      syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) => {
        events.push("plugins");
        expect(await serviceReadRuntime()).toMatchObject({ status: "stopped" });
        return pluginSyncResult(config);
      });

      if (succeeds) {
        await updateCommand({ yes: true, json: true }).catch((cause: unknown) => {
          throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, { cause });
        });
        expect(events).toEqual(["validate", "stop", "plugins"]);
        expect(spawn).toHaveBeenCalledOnce();
        expect(runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entryPath, "config", "validate", "--json"],
          expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
        );
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        const result = lastWriteJsonCall() as UpdateRunResult;
        expect(result.status).toBe("ok");
        expect(getUpdateRun(requireValue(result.runId, "updated run id"))).toMatchObject({
          status: "succeeded",
          downtimeMs: expect.any(Number),
          verification: { readyz: true, serviceRunning: true },
        });
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(events).toEqual(["validate"]);
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
        expect(freshRestartCalls()).toHaveLength(0);
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason:
            outcome === "live-config-change" ? "invalid-config" : "runtime-verification-failed",
        });
        await expect(
          fs.access(requireValue(candidateRoot, "candidate root")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const result = lastWriteJsonCall() as UpdateRunResult;
      const record = getUpdateRun(requireValue(result.runId, "run id"));
      expect(inferenceRepair).not.toHaveBeenCalled();
      expect(record?.repair).toEqual([]);
      expect(record?.steps.some((step) => step.step === "repairing")).toBe(false);
      if (outcome === "config-change") {
        expect(record?.reason).toBeNull();
        expect(
          record?.steps.flatMap((step) => (step.configChange ? [step.configChange] : [])),
        ).toEqual(doctorChanges);
      }
      if (outcome === "live-config-change") {
        expect(record?.reason).toBe("invalid-config");
        expect(spawn).not.toHaveBeenCalled();
        expect(
          JSON.parse(await fs.readFile(requireValue(liveConfigPath, "live config path"), "utf8")),
        ).toEqual({ logging: { level: "debug" } });
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
        expect(renderUpdateRunReport(requireValue(record, "update run")).lines).toContain(
          `Warning: ${warning}`,
        );
        expect(doctorCommandCall()).toBeDefined();
      }
    },
  );

  it.each(["owned-running", "no-restart", "stopped"] as const)(
    "uses compatibility-checked package update without full-state startup (%s)",
    async (mode) => {
      const root = await mockPackageInstallAtCaseDir("openclaw-update-startup-admission");
      mockCurrentProcessFreshDoctor({
        packageRoot: root,
        candidateAdmission: mode !== "no-restart",
      });
      mockFileBackedPathExists();
      mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      if (mode === "stopped") {
        serviceReadRuntime.mockResolvedValue({ status: "stopped" });
      }
      await invokeUpdateCli({
        yes: true,
        json: true,
        restart: mode !== "no-restart",
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(candidateValidation).toHaveBeenCalled();
      expect(doctorCommandCall()).toBeDefined();
      expect(await fs.readdir(path.dirname(profileStateDir()))).not.toContain(
        `.${path.basename(profileStateDir())}-update-checkpoints`,
      );
    },
  );

  it("keeps the live package unchanged when its executor is rebound during candidate validation", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-update-revoked-executor");
    mockFileBackedPathExists();
    const before = await fs.readFile(path.join(root, "package.json"));
    candidateValidation.mockImplementationOnce(async (options) => {
      const { createManagedHandoffLeaseStore } =
        await import("../infra/update-managed-service-handoff-lease.js");
      const store = createManagedHandoffLeaseStore();
      const found = store.read(resolveUpdateInstallRoot(root));
      if (found.kind !== "current") {
        throw new Error("Expected the real startup executor before candidate validation");
      }
      await Promise.resolve();
      expect(store.bind(found.lease, process.pid)).not.toBeNull();
      return reportCandidateSteps(options, {
        status: "ok",
        steps: [
          {
            name: "candidate-gateway-startup",
            command: "openclaw gateway",
            cwd: options.root,
            durationMs: 1,
            exitCode: 0,
          },
        ],
      });
    });
    await expect(updateCommand({ yes: true, json: true })).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "package.json"))).toEqual(before);
    expect(doctorCommandCall()).toBeUndefined();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
  });

  it("refuses activation when successful Doctor leaves the validated candidate schema unapplied", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-update-incomplete-migration");
    mockFileBackedPathExists();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(root, "dist", "index.js"),
    );
    candidateValidation.mockImplementationOnce(async (options) =>
      reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [
          {
            name: "candidate-gateway-startup",
            command: "openclaw gateway",
            cwd: root,
            durationMs: 1,
            exitCode: 0,
          },
        ],
      }),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(doctorCommandCall()).toBeDefined();
    expectNoSideEffects(serviceStart, serviceRestart, runDaemonRestart);
    expect(freshRestartCalls()).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
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
    const processOnSpy = vi.spyOn(process, "on");
    const processOffSpy = vi.spyOn(process, "off");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await mockPackageInstallAtCaseDir("openclaw-update-stop-service");
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockResolvedValue(path.join(root, "dist", "index.js"));
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "fixture" });
    mockFileBackedPathExists();

    await updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(`${getErrorOutput()}\n${getLogOutput()}`, { cause });
    });
    platformSpy.mockRestore();

    const doctorCall = doctorCommandCall();
    expect(doctorCall).toBeDefined();
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    const npmInstallCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const npmInstallCallOrder =
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[npmInstallCallIndex];
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_KIND).toBe("gateway");
    const serviceStopCallOrder = serviceStop.mock.invocationCallOrder[0];
    const requiredServiceStopCallOrder = requireValue(
      serviceStopCallOrder,
      "service stop call order",
    );
    const requiredNpmInstallCallOrder = requireValue(npmInstallCallOrder, "npm install call order");
    const suspendOrder = requireValue(
      suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0],
      "Scheduled Task suspend order",
    );
    const resumeOrder = requireValue(
      resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0],
      "Scheduled Task resume order",
    );
    const sigintListenerIndex = processOnSpy.mock.calls.findIndex(([event]) => event === "SIGINT");
    const sigintListenerOrder = requireValue(
      processOnSpy.mock.invocationCallOrder[sigintListenerIndex],
      "SIGINT recovery listener order",
    );
    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      }),
      expect.objectContaining({ beforeMutation: expect.any(Function) }),
    );
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      }),
      expect.objectContaining({ beforeMutation: expect.any(Function) }),
    );
    expect(sigintListenerOrder).toBeLessThan(suspendOrder);
    expect(suspendOrder).toBeLessThan(requiredServiceStopCallOrder);
    const validationOrder = requireValue(
      candidateValidation.mock.invocationCallOrder[0],
      "candidate validation order",
    );
    expect(requiredNpmInstallCallOrder).toBeLessThan(validationOrder);
    expect(validationOrder).toBeLessThan(suspendOrder);
    expect(requiredServiceStopCallOrder).toBeLessThan(resumeOrder);
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGBREAK", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGBREAK", expect.any(Function));
    processOnSpy.mockRestore();
    processOffSpy.mockRestore();
  });

  it.each([
    { platform: "darwin" as const, handoff: undefined },
    { platform: "linux" as const, handoff: "1" },
    { platform: "win32" as const, handoff: "1" },
  ])(
    "quiesces a stopped loaded managed gateway on $platform before package replacement",
    async ({ platform, handoff }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const tempDir = tempDirs.make(`openclaw-update-stopped-loaded-${platform}-`);
      const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
      primeServiceCommand(
        ["node", entryPath, "gateway", "run"],
        { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
        platform === "win32" ? resolveGatewayTaskScriptPath(process.env) : undefined,
      );
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      mockFileBackedPathExists();
      mockNpmGlobalRoot(nodeModules);
      let finishStop: (() => void) | undefined;
      let markStopStarted: (() => void) | undefined;
      const stopStarted = new Promise<void>((resolve) => {
        markStopStarted = resolve;
      });
      serviceStop.mockImplementationOnce(() => {
        markStopStarted?.();
        return new Promise<void>((resolve) => {
          finishStop = resolve;
        });
      });

      try {
        await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
          const updatePromise = updateCommand({ yes: true });
          const firstOutcome = await Promise.race([
            stopStarted.then(() => "stop" as const),
            updatePromise.then(() => "update" as const),
          ]);

          expect(firstOutcome).toBe("stop");
          expect(serviceStop).toHaveBeenCalledOnce();
          expect(packageInstallCommandCall()).toBeDefined();
          expect(candidateValidation).toHaveBeenCalledOnce();
          expect(
            JSON.parse(
              await fs.readFile(path.join(nodeModules, "openclaw", "package.json"), "utf8"),
            ),
          ).toMatchObject({
            version: "2026.4.21",
          });
          const pluginRecordCallsBeforeStop =
            loadInstalledPluginIndexInstallRecords.mock.calls.length;
          if (!finishStop) {
            throw new Error("expected the managed service stop to remain pending");
          }
          finishStop();
          await updatePromise;
          expect(loadInstalledPluginIndexInstallRecords.mock.calls.length).toBeGreaterThan(
            pluginRecordCallsBeforeStop,
          );
        });
      } finally {
        platformSpy.mockRestore();
      }

      expect(packageInstallCommandCall()).toBeDefined();
      expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalled();
      expect(serviceStop.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(
          loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder.at(-1),
          "owned managed update context capture order",
        ),
      );
    },
  );

  it.each([
    { name: "an unloaded Darwin LaunchAgent", platform: "darwin" as const, loaded: false },
    { name: "an ordinary stopped systemd unit", platform: "linux" as const, loaded: true },
    { name: "an ordinary stopped Scheduled Task", platform: "win32" as const, loaded: true },
  ])("leaves $name stopped during package replacement", async ({ platform, loaded }) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const tempDir = tempDirs.make(`openclaw-update-stopped-${platform}-`);
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(loaded);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    try {
      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, async () => {
        await updateCommand({ yes: true });
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it("leaves an enabled LaunchAgent untouched when staged installation fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tempDir = tempDirs.make("openclaw-update-stopped-launchagent-failure-");
    const { nodeModules, entryPath } = await setupInstalledPackageAtNodeModules(
      path.join(tempDir, "lib", "node_modules"),
    );
    const nodeRunner = path.join(tempDir, "bin", "node");
    primeServiceCommand([nodeRunner, entryPath, "gateway", "run"], {
      OPENCLAW_STATE_DIR: profileStateDir(),
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        throw new Error("package replacement failed");
      }
    });

    try {
      await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
        await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));
      });
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toEqual([]);

    const packageInstallCallIndex = commandCalls().findIndex(
      ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
    );
    expect(commandCalls()[packageInstallCallIndex]?.[0]).toContain("--prefix");
  });

  it("leaves a disabled stopped LaunchAgent disabled when package replacement fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tempDir = tempDirs.make("openclaw-update-disabled-launchagent-failure-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceEnabled.mockResolvedValue(false);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);
    mockPackageReplacementFailure("package replacement failed");

    try {
      await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(
      serviceStart,
      serviceStop,
      serviceRestart,
      runDaemonInstall,
      runDaemonRestart,
    );
    expect(freshRestartCalls()).toHaveLength(0);
  });

  it.each([
    { json: true, handoff: "1", expectedExitCode: 79 },
    { json: false, handoff: undefined, expectedExitCode: 1 },
  ])(
    "leaves the stopped Gateway down when Git mutation throws without a recovery verdict (json=$json)",
    async ({ json, handoff, expectedExitCode }) => {
      mockStoppedManagedGitGateway();
      setTty(true);
      setStdoutTty(true);
      const cause = new Error("ENOSPC while replacing runtime files");
      const failure = new Error(
        `updater interrupted after mutation: ${"replacement verification detail; ".repeat(12)}`,
        { cause },
      );
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
        await requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        restartHealthTestControl.snapshot = {
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
        withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, () => updateCommand({ json })),
      ).rejects.toEqual(new ExitError(expectedExitCode));
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(freshRestartCalls()).toHaveLength(0);
      expectNoSideEffects(serviceStart, serviceRestart);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledTimes(json ? 0 : 1);
      const reportedFailure = json
        ? { result: lastWriteJsonCall() }
        : triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
      expect(reportedFailure).toMatchObject({
        result: {
          status: "error",
          mode: "git",
          reason: "update-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          verification: { serviceRunning: false, readyz: false, settled: false },
          steps: [
            expect.objectContaining({ exitCode: 1, stderrTail: formatErrorMessage(failure) }),
            recoveryVerificationStep([
              {
                check: "settled",
                code: "timeout",
                message: "Gateway remains stopped after interrupted mutation.",
              },
            ]),
          ],
        },
      });
      if (!json) {
        const recovery = expectDefined(
          triageCommand.mock.calls[0]?.[1]?.recovery,
          "captured failed-update recovery",
        );
        const diagnostic = sanitizeTriageUpdateFailure(recovery.updateFailure, {
          env: {},
          stateDir: profileStateDir(),
        });
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining("updater interrupted after mutation"),
        });
        expect(diagnostic.error).toContain(cause.message);
      }
    },
  );
});
