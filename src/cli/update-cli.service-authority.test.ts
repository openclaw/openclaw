import { once } from "node:events";
import fsSync from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import * as serviceMembership from "../daemon/service-process-membership.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  expectNoSideEffects,
  expectPackageInstallSpec,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
  managedUpdateHandoff,
  mockGetSelfAndAncestorPidsSync,
  pathExists,
  probePortUsage,
  serviceFixtureState,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  confirm,
  select,
  serviceDefinitionMutationCapability,
  sourceRuntimeCompletion,
  suspendScheduledTaskAutoStartForUpdate,
  updateFailureActionMocks,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  invokeUpdateCli,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runUpdateFailureTriage,
  updateCommand,
  updateGitCheckout,
  updateStatusCommand,
  listUpdateRuns,
  runDaemonInstall,
  runDaemonRestart,
} from "./update-cli-modules.test-support.js";
import { recoveryVerificationStep } from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    createCaseDir,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeServiceCommand,
    runWithGatewayServiceEnv,
    setupInstalledPackageRoot,
    mockPackageInstallStatus,
    setStdoutTty,
    setTty,
    tempDirs,
  } = createUpdateCliFixture();

  it("admits an absent service update while its selected port has an unmanaged listener", async () => {
    await mockPackageInstallAtCaseDir();
    const actualPortsProbe =
      await vi.importActual<typeof import("../infra/ports-probe.js")>("../infra/ports-probe.js");
    probePortUsage.mockImplementation(actualPortsProbe.probePortUsage);
    const listener = createServer();
    try {
      listener.listen(serviceFixtureState.absentServicePort, "127.0.0.1");
      await once(listener, "listening");
      await runWithGatewayServiceEnv({ yes: true });
      expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
      expectPackageInstallSpec("openclaw@9999.0.0");
      expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    } finally {
      if (listener.listening) {
        const closed = once(listener, "close");
        listener.close();
        await closed;
      }
    }
  });

  it.each([
    {
      caller: "external",
      inheritedMarkers: true,
      ancestors: [1],
      pid: undefined,
      runtime: undefined,
      code: undefined,
    },
    {
      caller: "inspected Gateway",
      inheritedMarkers: true,
      ancestors: [gatewayFixturePid, 1],
      pid: gatewayFixturePid,
      runtime: undefined,
      code: "inside-gateway-process-tree",
    },
    {
      caller: "another Gateway with stopped service",
      inheritedMarkers: true,
      ancestors: [gatewayFixturePid + 1, 1],
      pid: gatewayFixturePid + 1,
      runtime: { status: "stopped", state: "stopped" },
      code: "inside-gateway-process-tree",
    },
    {
      caller: "incomplete ancestry and stopped service",
      inheritedMarkers: false,
      ancestors: [],
      pid: process.ppid,
      runtime: { status: "stopped", state: "stopped", pid: gatewayFixturePid },
      code: "service-ancestry-unverified",
    },
    {
      caller: "dead inherited PID",
      inheritedMarkers: false,
      ancestors: [],
      pid: 2_000_000_000,
      runtime: { status: "stopped", state: "stopped" },
      code: undefined,
    },
  ])(
    "checks inherited Gateway ancestry before --no-restart updates: $caller",
    async ({ inheritedMarkers, ancestors, pid, runtime, code }) => {
      const root = await mockPackageInstallAtCaseDir();
      primeServiceCommand(
        [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
        inheritedMarkers
          ? { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" }
          : undefined,
      );
      serviceLoaded.mockResolvedValue(true);
      if (runtime) {
        serviceReadRuntime.mockResolvedValue(runtime);
      }
      mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, ...ancestors]));
      const env = pid === undefined ? {} : { [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(pid) };
      if (!code) {
        await runWithGatewayServiceEnv({ yes: true, restart: false }, env);
        expectPackageInstallSpec("openclaw@9999.0.0");
        expect(serviceStop).not.toHaveBeenCalled();
        return;
      }
      await expect(
        runWithGatewayServiceEnv({ yes: true, restart: false, json: true }, env),
      ).rejects.toEqual(new ExitError(1));
      expect(lastWriteJsonCall()).toMatchObject({
        reason: "managed-service-preflight",
        steps: expect.arrayContaining([
          expect.objectContaining({ failureFacts: [expect.objectContaining({ code })] }),
        ]),
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(serviceStop, updateGitCheckout);
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    },
  );

  it("runs an owned managed update when native membership is absent", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await mockPackageInstallAtCaseDir();
    mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    mockGatewayHealth("1.0.0", "before-update");
    vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue("absent");
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, 1]));
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockResolvedValue(path.join(root, "dist", "index.js"));

    await invokeUpdateCli({ yes: true, json: true });

    expect(serviceStop).toHaveBeenCalledOnce();
    await expect(serviceReadRuntime()).resolves.toMatchObject({ status: "running" });
    expectPackageInstallSpec("openclaw@9999.0.0");
    const message =
      "Service membership unverifiable on this host; using managed stop/update/start.";
    expect(lastWriteJsonCall()).toMatchObject({
      status: "ok",
      after: { version: "9999.0.0" },
      steps: expect.arrayContaining([
        expect.objectContaining({ advisory: { kind: "recoverable-maintenance", message } }),
      ]),
    });
    await updateStatusCommand({ json: true });
    expect(lastWriteJsonCall()).toMatchObject({
      lastRun: {
        status: "succeeded",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "warning:managed-service-membership",
            status: "completed",
            detail: message,
          }),
        ]),
      },
    });
  });

  it.each<{
    platform: "linux" | "darwin";
    env: NodeJS.ProcessEnv;
    supervisor: "systemd" | "launchd";
    options?: Parameters<typeof updateCommand>[0];
    ancestor?: boolean;
    git?: boolean;
  }>([
    { platform: "linux", env: {}, supervisor: "systemd", ancestor: true },
    {
      platform: "linux",
      env: { INVOCATION_ID: "gateway-invocation" },
      supervisor: "systemd",
      options: { tag: "./candidate.tgz" },
    },
    {
      platform: "darwin",
      env: { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
      supervisor: "launchd",
    },
    { platform: "linux", env: {}, supervisor: "systemd", ancestor: true, git: true },
  ])(
    "hands agent-initiated updates to $supervisor before stopping the gateway ($env, git=$git)",
    async ({ platform, env, supervisor, options = {}, ancestor = true, git = false }) => {
      const phases = vi.spyOn(
        await import("./update-cli/update-command-service.js"),
        "maybeStopManagedServiceBeforeMutableUpdate",
      );
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const caseDir = createCaseDir("openclaw-update-handoff");
      const sha = "a".repeat(40);
      const { pkgRoot: root, entryPath } = git
        ? {
            pkgRoot: caseDir,
            entryPath: await writeOpenClawPackageFixture(caseDir, "1.0.0", {
              git: true,
              builtSha: sha,
              entrySource: "export {};\n",
            }),
          }
        : await setupInstalledPackageRoot(caseDir);
      if (git) {
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
        vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
        vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: updateOptions }) => {
          await updateOptions.inspectGitTarget({});
          await requireValue(updateOptions.beforeGitMutation, "Git mutation admission")({});
          return makeOkUpdateResult();
        });
      }
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      if (ancestor) {
        mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, gatewayFixturePid]));
      }
      managedUpdateHandoff.start.mockResolvedValue({
        status: "started",
        handoffId: "test-handoff",
        installRoot: root,
        logPath: "/tmp/update-handoff/handoff.log",
        command: "openclaw update --yes",
        pid: 12345,
      });
      managedUpdateHandoff.transfer.mockResolvedValue(true);

      await withEnvAsync(env, () =>
        invokeUpdateCli({ yes: true, json: true, acceptCapabilities: true, ...options }),
      ).catch((error: unknown) => {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, {
          cause: error,
        });
      });

      expect(managedUpdateHandoff.start, getErrorOutput() || getLogOutput()).toHaveBeenCalledWith(
        expect.objectContaining({
          root,
          supervisor,
          parentPid: gatewayFixturePid,
          invocationCwd: process.cwd(),
          tag:
            git || options.channel === "extended-stable" ? undefined : (options.tag ?? "9999.0.0"),
          acceptCapabilities: true,
        }),
      );
      expect(managedUpdateHandoff.transfer).toHaveBeenCalledWith({
        kind: "managed-update-handoff",
        handoffId: "test-handoff",
        installRoot: root,
      });
      expect(phases.mock.calls.every(([params]) => params.phase === "inspect")).toBe(true);
      expect(phases.mock.calls.length).toBeGreaterThan(1);
      expectNoSideEffects(serviceStop, serviceRestart);
      expect(freshRestartCalls()).toHaveLength(0);
      expect(updateGitCheckout).toHaveBeenCalledTimes(git ? 1 : 0);
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "skipped",
        reason: "managed-service-handoff-started",
        steps: [
          expect.objectContaining({
            stdoutTail: expect.stringContaining("/tmp/update-handoff/handoff.log"),
          }),
        ],
      });
      expect(JSON.stringify(lastWriteJsonCall())).toContain("openclaw update status");
    },
  );

  it("reports a Git service refusal at the final ancestry recheck without an unsafe recovery verdict", async () => {
    const root = createCaseDir("openclaw-git-ancestry-refusal");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(root, "1.0.0", {
      git: true,
      builtSha: sha,
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    pathExists.mockImplementation(async (candidate: string) =>
      [path.join(root, "package.json"), path.join(root, "dist", "index.js")].includes(candidate),
    );
    vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
    mockRunningManagedGateway([nodeExecutable, path.join(root, "dist", "index.js"), "gateway"]);
    const mutationAdmitted = mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid, 1]));
    const runningRuntime = { status: "running", pid: gatewayFixturePid, state: "running" };
    // The final reread follows the ancestry check immediately before shutdown.
    // Additional schema inspections must not move this fault into handoff selection.
    let preparing = false;
    let preparationReads = 0;
    const maintenance = await import("./update-cli/update-command-service-maintenance.js");
    vi.spyOn(
      await import("./update-cli/update-command-service.js"),
      "maybeStopManagedServiceBeforeMutableUpdate",
    ).mockImplementation(async (params) => {
      preparing = params.phase === "prepare";
      return maintenance.maybeStopManagedServiceBeforeMutableUpdate(params);
    });
    serviceReadRuntime.mockImplementation(async () => {
      if (preparing && ++preparationReads === 2) {
        mockGetSelfAndAncestorPidsSync.mockReturnValue(
          new Set<number>([process.pid, gatewayFixturePid]),
        );
      }
      return runningRuntime;
    });

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () =>
        invokeUpdateCli({ yes: true, json: true }),
      ),
    ).rejects.toEqual(new ExitError(1));

    expect(runUpdateFailureTriage).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-preflight",
      recovery: { serviceRestartSafe: true },
      steps: [
        expect.objectContaining({
          stderrTail: expect.stringContaining("would kill this command"),
        }),
        recoveryVerificationStep(
          [
            {
              check: "versionMatch",
              code: "build-id-mismatch",
              message: "Expected Gateway build fixture-original-build; observed unavailable.",
            },
          ],
          root,
        ),
      ],
    });
    expect(mutationAdmitted).not.toHaveBeenCalled();
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(getErrorOutput()).not.toContain("Update recovery is unverified");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("admits non-TTY updates with an active session without confirmation", async () => {
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
      await invokeUpdateCli({});
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

  it.each(["launcher", "writable configuration"] as const)(
    "refuses native preparation after admitted %s drift",
    async (drift) => {
      const argv = [nodeExecutable, path.join(process.cwd(), "dist", "index.js"), "gateway"];
      mockRunningManagedGateway(argv);
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      const params = {
        updateInstallKind: "package" as const,
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
      };
      if (drift === "launcher") {
        const original = await serviceReadCommand(process.env);
        serviceReadCommand.mockResolvedValueOnce(original).mockResolvedValue({
          ...original,
          programArguments: ["/foreign/openclaw", "gateway"],
        });
        await expect(maybeStopManagedServiceBeforeMutableUpdate(params)).rejects.toThrow(
          "ownership or manager identity changed",
        );
      } else {
        const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
          ...params,
          phase: "inspect",
        });
        expect(inspected.serviceUpdateVerdict).toMatchObject({
          kind: "owned",
          refreshDefinition: true,
        });
        primeServiceCommand(argv, { PREFLIGHT_STORE_ROOT: createCaseDir("service-config-drift") });
        await expect(
          maybeStopManagedServiceBeforeMutableUpdate({
            ...params,
            expectedService: inspected,
            phase: "prepare",
          }),
        ).rejects.toThrow("changed");
        expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
      }
      expect(serviceStop).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "git", platform: "linux", restart: true, fault: "read" },
    { kind: "package", platform: "darwin", restart: false, fault: "stale-record" },
  ] as const)(
    "admits $kind on $platform with restart=$restart when service inspection is unavailable ($fault)",
    async ({ kind, platform, restart, fault }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      if (kind === "package") {
        await mockPackageInstallAtCaseDir();
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
    { kind: "package", restart: false, capability: "sealed" },
    { kind: "package", restart: true, capability: "sealed" },
    { kind: "git", restart: true, capability: "unknown" },
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
      mockRunningManagedGateway([nodeExecutable, entrypoint, "gateway", "--port", "18789"]);
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
      mockRunningManagedGateway([
        nodeExecutable,
        path.join(process.cwd(), "dist", "index.js"),
        "gateway",
      ]);
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: beforeKind, detail: "owner" });
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      const { revalidateManagedGatewayServiceAfterUpdate } =
        await import("./update-cli/update-command-service-revalidation.js");
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

  it.each(["unchanged", "changed"] as const)(
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
  it.each([
    { kind: "git", restart: false, ownership: "unresolved" },
    { kind: "package", restart: false, ownership: "unresolved" },
  ] as const)(
    "admits $kind with restart=$restart when service ownership is $ownership",
    async ({ kind, restart }) => {
      if (kind === "package") {
        await mockPackageInstallAtCaseDir();
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
});
