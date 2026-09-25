import fsSync from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  expectNoSideEffects,
  expectPackageInstallSpec,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  confirm,
  gatewayFixturePid,
  managedUpdateHandoff,
  select,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  sourceRuntimeCompletion,
  suspendScheduledTaskAutoStartForUpdate,
  updateFailureActionMocks,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    createCaseDir,
    mockCurrentProcessFreshDoctor,
    mockGatewayHealth,
    mockPackageGatewayLifecycle,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockRunningManagedGateway,
    primeServiceCommand,
    setStdoutTty,
    setTty,
    setupServicePackageAtPrefix,
    tempDirs,
  } = createUpdateCliFixture();

  it.each([false, true])(
    "reports a fresh refusal once through Commander (json=%s)",
    async (json) => {
      await mockPackageInstallAtCaseDir();
      const stateDir = tempDirs.make("openclaw-fresh-cli-refusal-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(invokeUpdateCli({ tag: "main", yes: true, json })).rejects.toEqual(
          new ExitError(1),
        );
        expect(fsSync.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeUndefined();
      if (json) {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "unsupported-package-target",
        });
        expect(vi.mocked(defaultRuntime.error).mock.calls.length).toBe(1);
      } else {
        expect(getLogOutput()).toContain("--tag main");
        expect(defaultRuntime.error).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])("admits non-TTY updates with an active session (yes=%s)", async (yes) => {
    setTty(false);
    setStdoutTty(false);
    const { beginSessionWorkAdmission, getActiveSessionWorkAdmissionCount } =
      await import("../sessions/session-lifecycle-admission.js");
    const admission = await beginSessionWorkAdmission({
      scope: path.join(resolveStateDir(), "agents", "main", "sessions", "sessions.json"),
      identities: ["agent:main:ssh-update", "ssh-update-session"],
      assertAllowed: () => {},
    });
    try {
      mockRunningManagedGateway([
        process.execPath,
        path.join(process.cwd(), "dist", "index.js"),
        "gateway",
        "run",
      ]);
      vi.mocked(updateGitCheckout).mockImplementation(async ({ opts }) => {
        expect(getActiveSessionWorkAdmissionCount()).toBe(1);
        await opts.inspectGitTarget({});
        await expectDefined(opts.beforeGitMutation, "Git mutation admission")({});
        return makeOkUpdateResult({ root: process.cwd() });
      });
      await invokeUpdateCli(yes ? { yes: true } : {});
      expect(updateGitCheckout).toHaveBeenCalledOnce();
      expect(sourceRuntimeCompletion).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(updateFailureActionMocks.runInteractiveUpdateFailureAction).not.toHaveBeenCalled();
      expect(getActiveSessionWorkAdmissionCount()).toBe(1);
    } finally {
      admission.release();
    }
  });

  it("refuses to stop a service whose effective launcher changed during inspection", async () => {
    mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
    const original = await serviceReadCommand(process.env);
    serviceReadCommand.mockResolvedValueOnce(original).mockResolvedValue({
      ...original,
      programArguments: ["/foreign/openclaw", "gateway"],
    });
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
      }),
    ).rejects.toThrow("ownership or manager identity changed");
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it("pins the admitted writable service configuration before native preparation", async () => {
    const argv = ["node", path.join(process.cwd(), "dist", "index.js"), "gateway"];
    mockRunningManagedGateway(argv);
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect",
    });
    expect(inspected.serviceUpdateVerdict).toMatchObject({
      kind: "owned",
      refreshDefinition: true,
    });
    // The service manager/profile stay identical; a config substitution now selects another store.
    primeServiceCommand(argv, { PREFLIGHT_STORE_ROOT: createCaseDir("service-config-drift") });
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
        expectedService: inspected,
        phase: "prepare",
      }),
    ).rejects.toThrow("changed");
    expectNoSideEffects(serviceStop, suspendScheduledTaskAutoStartForUpdate);
  });

  it("recovers a stopped sealed service after staged npm installation fails", async () => {
    const {
      root,
      nodeModules,
      entrypoint,
      serviceNode: nodeRunner,
    } = await setupServicePackageAtPrefix({
      prefix: createCaseDir("staging-recovery"),
      version: "1.0.0",
    });
    mockRunningManagedGateway([nodeRunner, entrypoint, "gateway"]);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "root owner" });
    const activateGateway = mockPackageGatewayLifecycle();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      await activateGateway(argv);
      return commandResult();
    });
    const {
      maybeStopManagedServiceBeforeMutableUpdate,
      maybeRestartServiceAfterFailedMutableUpdate,
    } = await import("./update-cli/update-command-service.js");
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
    });
    expect(before?.stopped).toBe(true);
    const { runGlobalPackageUpdateSteps } = await import("../infra/package-update-steps.js");
    const result = await runGlobalPackageUpdateSteps({
      installTarget: {
        manager: "npm",
        command: "npm",
        globalRoot: nodeModules,
        packageRoot: root,
        npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
      },
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      packageRoot: root,
      runCommand: async () => ({ code: 0, stdout: nodeModules, stderr: "" }),
      runStep: async ({ name, argv }) => {
        expect(argv).toContain("--prefix");
        return { name, command: argv.join(" "), cwd: root, durationMs: 0, exitCode: 1 };
      },
      timeoutMs: 1000,
    });
    expect(result.failedStep?.exitCode).toBe(1);
    expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
    await expect(
      maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        recovery: result.recovery,
        jsonMode: true,
        nodeRunner,
        timeoutMs: 17_000,
        invocationCwd: root,
      }),
    ).resolves.toBe("healthy");
    expect(freshRestartCalls()).toEqual([
      [
        [nodeRunner, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
        expect.objectContaining({
          cwd: root,
          timeoutMs: 17_000,
          baseEnv: {},
          env: expect.objectContaining({ NODE_DISABLE_COMPILE_CACHE: "1" }),
        }),
      ],
    ]);
    expectNoSideEffects(serviceStart, serviceRestart, runDaemonInstall, runDaemonRestart);
  });

  it.each(
    (["git", "package"] as const).flatMap((kind) =>
      (["darwin", "linux"] as const).flatMap((platform) =>
        [false, true].flatMap((restart) =>
          ["read", "stale-record"].map((fault) => ({ kind, platform, restart, fault })),
        ),
      ),
    ),
  )(
    "admits $kind on $platform with restart=$restart when service inspection is unavailable ($fault)",
    async ({ kind, platform, restart, fault }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      if (kind === "package") {
        await mockPackageInstallAtCaseDir();
        mockCurrentProcessFreshDoctor();
      } else {
        mockGitUpdateAfterMutation();
      }
      const staleState = path.join(createCaseDir("stale-service-record"), "state");
      if (fault === "read") {
        serviceReadCommand.mockRejectedValue(new Error("inspection-secret-canary"));
      } else {
        primeServiceCommand(["/old-node/bin/node", "/old-install/dist/index.js", "gateway"], {
          OPENCLAW_STATE_DIR: staleState,
        });
        serviceLoaded.mockRejectedValue(new Error("manager unavailable"));
        serviceReadRuntime.mockResolvedValue({ status: "unknown" });
      }

      await invokeUpdateCli({ yes: true, json: true, restart });

      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: "managed-service",
            failureFacts: expect.arrayContaining([
              expect.objectContaining({
                check: "managed-service",
                code: "service-inspection-unavailable",
              }),
            ]),
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining("Restart the Gateway you launched manually"),
            },
          }),
        ]),
      });
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        runDaemonInstall,
        runDaemonRestart,
      );
      expect(
        listUpdateRuns({ limit: 1 })[0]?.steps.some(
          (step) =>
            step.step === "warning:managed-service" &&
            step.detail?.includes("Restart the Gateway you launched manually"),
        ),
      ).toBe(true);
      expect(fsSync.existsSync(staleState)).toBe(false);
      expect(getErrorOutput()).not.toContain("inspection-secret-canary");
    },
  );

  it.each([
    { kind: "git", restart: false, ownership: "unresolved" },
    { kind: "package", restart: false, ownership: "unresolved" },
  ] as const)(
    "admits $kind with restart=$restart when service ownership is $ownership",
    async ({ kind, restart }) => {
      if (kind === "package") {
        await mockPackageInstallAtCaseDir();
        mockCurrentProcessFreshDoctor();
      } else {
        mockGitUpdateAfterMutation();
      }
      mockRunningManagedGateway(["openclaw-wrapper", "gateway", "run"]);

      await invokeUpdateCli({ yes: true, json: true, restart });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(getErrorOutput()).toContain("gateway status --deep");
      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "managed-service", advisory: expect.any(Object) }),
        ]),
      });
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        runDaemonInstall,
        runDaemonRestart,
      );
      expect(freshRestartCalls()).toHaveLength(0);
      expect(getErrorOutput()).not.toContain("inspection-secret-canary");
    },
  );

  it("keeps root and fallback service planning on loaded-only native reads", async () => {
    const root = await mockPackageInstallAtCaseDir();
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    const { resolveManagedServicePackageUpdatePlan, gatewayServiceCommandUsesRoot } =
      await import("./update-cli/update-command-service-plan.js");
    await resolveManagedServicePackageUpdatePlan({ root });
    await expect(gatewayServiceCommandUsesRoot({ root })).resolves.toBe(true);
    expect(serviceReadCommand).toHaveBeenCalledTimes(2);
    for (const call of serviceReadCommand.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ requireEffective: true, requireLoaded: true }),
      );
    }
    expectNoSideEffects(serviceStart, serviceStop, serviceRestart, replaceConfigFile);
  });

  it("admits a restart-enabled update when service load inspection is unknown", async () => {
    mockRunningManagedGateway([
      "node",
      path.join(process.cwd(), "dist", "index.js"),
      "gateway",
      "run",
    ]);
    mockGitUpdateAfterMutation();
    serviceLoaded.mockRejectedValue(new Error("load-state-secret-canary"));

    await invokeUpdateCli({ yes: true, json: true });

    expect(updateGitCheckout).toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain("Restart the Gateway you launched manually");
    expect(getErrorOutput()).not.toContain("load-state-secret-canary");
  });

  it.each(["absent", "stopped"] as const)(
    "keeps compatible no-restart package updates available with a proven %s service",
    async (state) => {
      const root = await mockPackageInstallAtCaseDir(`compatible-${state}`);
      if (state === "stopped") {
        mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
        serviceLoaded.mockResolvedValue(false);
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
      await updateCommand({ yes: true, json: true, restart: false });
      expect(packageInstallCommandCall()).toBeDefined();
      expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
      expect(freshRestartCalls()).toHaveLength(0);
    },
  );

  it.each([
    { kind: "git", restart: true, capability: "sealed" },
    { kind: "package", restart: false, capability: "sealed" },
    { kind: "package", restart: true, capability: "sealed" },
    { kind: "git", restart: true, capability: "unknown" },
    { kind: "package", restart: true, capability: "unknown" },
  ] as const)(
    "updates $kind with stale $capability metadata and restart=$restart",
    async ({ kind, restart, capability }) => {
      const root =
        kind === "package"
          ? await mockPackageInstallAtCaseDir("openclaw-sealed-code-update")
          : process.cwd();
      const entrypoint =
        kind === "package"
          ? await writeOpenClawPackageFixture(root, "1.0.0", {
              entrySource: "export {};\n",
              inventory: true,
            })
          : path.join(root, "dist", "index.js");
      if (kind === "package") {
        mockPackageInstallStatus(root);
        mockGatewayHealth("9999.0.0", "updated-service");
      } else {
        mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
      }
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entrypoint);
      // No managed mode, token, or env-key metadata: this must not become an install-plan veto.
      mockRunningManagedGateway(["node", entrypoint, "gateway", "--port", "18789"]);
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: capability,
        detail: "definition-owner-secret-canary",
      });

      await updateCommand({ yes: true, json: true, restart }).catch((cause: unknown) => {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, { cause });
      });

      if (kind === "package") {
        expectPackageInstallSpec("openclaw@9999.0.0", true);
      } else {
        expect(updateGitCheckout).toHaveBeenCalledOnce();
        expect(sourceRuntimeCompletion).toHaveBeenCalledWith(expect.objectContaining({ root }));
      }
      expect(serviceStop).toHaveBeenCalledTimes(restart ? 1 : 0);
      expect(freshRestartCalls().length).toBe(restart ? 1 : 0);
      expect(serviceStart).not.toHaveBeenCalled();
      expectNoSideEffects(managedUpdateHandoff.start, runDaemonInstall, runDaemonRestart);
      expect(getErrorOutput()).toContain("service definition left unchanged");
      expect(getErrorOutput()).not.toContain("definition-owner-secret-canary");
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
    },
  );

  it.each([
    ["sealed", "writable"],
    ["writable", "unknown"],
  ] as const)(
    "retains activation but not refresh when authority changes %s -> %s",
    async (beforeKind, afterKind) => {
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: beforeKind, detail: "owner" });
      const {
        maybeStopManagedServiceBeforeMutableUpdate,
        revalidateManagedGatewayServiceAfterUpdate,
      } = await import("./update-cli/update-command-service.js");
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "git",
        shouldRestart: true,
        jsonMode: true,
      });
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: afterKind, detail: "owner" });
      const { readGatewayServiceState, resolveGatewayService } =
        await import("../daemon/service.js");
      const state = await readGatewayServiceState(resolveGatewayService(), {
        requireEffective: true,
      });
      await expect(
        revalidateManagedGatewayServiceAfterUpdate({
          state,
          root: process.cwd(),
          preManagedServiceStop: before,
        }),
      ).resolves.toMatchObject({ kind: "owned", refreshDefinition: false });
    },
  );

  it.each(["unchanged", "changed", "unreadable"] as const)(
    "recovers shipped unresolved services only with unchanged inspection (%s)",
    async (inspection) => {
      const entrypoint = path.join(process.cwd(), "dist", "index.js");
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      mockRunningManagedGateway();
      const { maybeRestartServiceAfterFailedMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      // Shipped handoffs can retain this launcher; fresh admission no longer stops it.
      const { createShippedUnresolvedServiceStop } =
        await import("./update-cli/update-command-service-state.test-support.js");
      const before = createShippedUnresolvedServiceStop(process.env, process.cwd());
      serviceReadRuntime.mockImplementation(async () =>
        freshRestartCalls().length > 0
          ? { status: "running", pid: gatewayFixturePid, state: "running" }
          : { status: "stopped", state: "stopped" },
      );
      if (inspection === "changed") {
        mockRunningManagedGateway(["foreign-openclaw", "gateway", "run"]);
      } else if (inspection === "unreadable") {
        serviceReadCommand.mockRejectedValueOnce(new Error("manager unavailable"));
      }

      await maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
        jsonMode: true,
      });

      expectNoSideEffects(serviceStart, serviceRestart);
      if (inspection === "unchanged") {
        expect(freshRestartCalls()).toEqual([
          [
            [process.execPath, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
            expect.objectContaining({ cwd: process.cwd(), baseEnv: {} }),
          ],
        ]);
      } else {
        expect(freshRestartCalls()).toHaveLength(0);
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to restart managed gateway service after failed update"),
        );
      }
    },
  );

  it("fails sealed-service activation without claiming a successful restart", async () => {
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce(
      commandResult({ code: 1, stderr: "systemctl restart denied" }),
    );
    const { maybeRestartService } = await import("./update-cli/update-command-service.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue("/updated/dist/index.js");

    await expect(
      maybeRestartService({
        shouldRestart: true,
        result: makeOkUpdateResult({ mode: "npm", after: { version: "2026.4.24" } }),
        opts: { json: true },
        refreshServiceEnv: false,
        serviceUpdateVerdict: {
          kind: "owned",
          root: process.cwd(),
          refreshDefinition: false,
          fingerprint: "sealed",
        },
        serviceEnv: { MANAGED_VALUE: "revalidated" },
        gatewayPort: 18789,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("failed");

    expect(freshRestartCalls().length).toBe(1);
    expect(serviceStart).not.toHaveBeenCalled();
    expectNoSideEffects(runDaemonInstall, runDaemonRestart, serviceRestart);
  });
});
