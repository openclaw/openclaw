import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import * as serviceMembership from "../daemon/service-process-membership.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  doctorCommandCall,
  expectNoSideEffects,
  expectPackageInstallSpec,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  getTriageFailures,
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
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  invokeUpdateCli,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runUpdateFailureTriage,
  updateCommand,
  updateGitCheckout,
  updateStatusCommand,
} from "./update-cli-modules.test-support.js";
import { recoveryVerificationStep } from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    createCaseDir,
    mockFileBackedPathExists,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeServiceCommand,
    runWithGatewayServiceEnv,
    setupInstalledPackageRoot,
  } = createUpdateCliFixture();

  it("allows package updates from inherited gateway service env when the managed gateway is not running", async () => {
    await mockPackageInstallAtCaseDir();
    serviceReadRuntime.mockResolvedValueOnce({
      status: "stopped",
      state: "stopped",
      missingUnit: true,
    });

    await runWithGatewayServiceEnv({ yes: true });

    expectPackageInstallSpec("openclaw@9999.0.0");
  });

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
    "external",
    "inspected Gateway",
    "another Gateway",
    "another Gateway with stopped service",
  ])(
    "checks ancestry before --no-restart package updates with inherited markers (%s)",
    async (caller) => {
      const inside = caller !== "external";
      const callerGatewayPid = caller.startsWith("another Gateway")
        ? gatewayFixturePid + 1
        : gatewayFixturePid;
      const root = await mockPackageInstallAtCaseDir();
      primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      serviceLoaded.mockResolvedValue(true);
      if (caller === "another Gateway with stopped service") {
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
      mockGetSelfAndAncestorPidsSync.mockReturnValue(
        new Set(inside ? [process.pid, callerGatewayPid, 1] : [process.pid, 1]),
      );

      if (!inside) {
        await runWithGatewayServiceEnv({ yes: true, restart: false });
        expectPackageInstallSpec("openclaw@9999.0.0");
        expect(serviceStop).not.toHaveBeenCalled();
        return;
      }
      await expect(
        runWithGatewayServiceEnv(
          { yes: true, restart: false, json: true },
          {
            [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(callerGatewayPid),
          },
        ),
      ).rejects.toEqual(new ExitError(1));

      expect(lastWriteJsonCall()).toMatchObject({
        reason: "managed-service-preflight",
        steps: expect.arrayContaining([
          expect.objectContaining({
            failureFacts: [expect.objectContaining({ code: "inside-gateway-process-tree" })],
          }),
        ]),
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(serviceStop, updateGitCheckout);
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    },
  );

  it.each([
    {
      name: "runtime probe fails",
      setupRuntime: () => serviceReadRuntime.mockRejectedValue(new Error("runtime probe failed")),
    },
    {
      name: "runtime status is unknown",
      setupRuntime: () => serviceReadRuntime.mockResolvedValue({ status: "unknown" }),
    },
  ])(
    "admits package updates from inherited gateway service env when $name",
    async ({ setupRuntime }) => {
      const root = await mockPackageInstallAtCaseDir();
      primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      setupRuntime();

      await runWithGatewayServiceEnv({ yes: true });

      expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
      expect(getTriageFailures()).toEqual([]);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(serviceStop, updateGitCheckout);
      expectPackageInstallSpec("openclaw@9999.0.0");
    },
  );

  it("admits package updates from inherited gateway service env when the service definition is missing but runtime is live", async () => {
    await mockPackageInstallAtCaseDir();
    serviceReadCommand.mockResolvedValue(null);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });

    await runWithGatewayServiceEnv({ yes: true });

    expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
    expect(getTriageFailures()).toEqual([]);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectNoSideEffects(serviceStop, updateGitCheckout);
    expectPackageInstallSpec("openclaw@9999.0.0");
  });

  it("refuses package updates from inside the active gateway process tree", async () => {
    const root = await mockPackageInstallAtCaseDir();
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(
      new Set<number>([process.pid, gatewayFixturePid]),
    );

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () => invokeUpdateCli({ yes: true })),
    ).rejects.toEqual(new ExitError(1));

    const errors = getErrorOutput();
    expect(errors).toContain(
      `This command is running inside the gateway process tree (gateway PID ${gatewayFixturePid}).`,
    );
    expect(errors).not.toContain("Run this command from a shell outside the gateway service.");
    expect(errors).toContain("would kill this command");
    expect(errors).toContain("gateway update action or /update");
    expect(errors).not.toContain("stop the gateway service first");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
    expect(doctorCommandCall()).toBeUndefined();
  });

  it.each(["linux", "darwin"] as const)(
    "names an external-terminal recovery path when native membership is unverified on %s",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const root = await mockPackageInstallAtCaseDir();
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue("unknown");
      mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, 1]));

      await expect(invokeUpdateCli({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

      expect(getErrorOutput()).toContain(
        "From an interactive external shell not started by the service",
      );
      expect(getErrorOutput()).toContain("With native helper support (systemd-run on Linux)");
      expect(lastWriteJsonCall()).toMatchObject({
        reason: "managed-service-preflight",
        steps: expect.arrayContaining([
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({
                code: "service-membership-unverified",
                message: expect.stringContaining(
                  "openclaw gateway stop && openclaw update --yes && openclaw gateway start",
                ),
              }),
            ],
          }),
        ]),
      });
      expectNoSideEffects(serviceStop, serviceRestart, serviceStart);
      expect(packageInstallCommandCall()).toBeUndefined();
      await updateStatusCommand({ json: true });
      expect(lastWriteJsonCall()).toMatchObject({
        lastRun: {
          reason: "managed-service-preflight",
          steps: expect.arrayContaining([
            expect.objectContaining({
              failureFacts: [
                expect.objectContaining({
                  code: "service-membership-unverified",
                  message: expect.stringContaining(
                    "openclaw gateway stop && openclaw update --yes && openclaw gateway start",
                  ),
                }),
              ],
            }),
          ]),
        },
      });
    },
  );

  it.each<{
    platform: "linux" | "darwin";
    env: NodeJS.ProcessEnv;
    supervisor: "systemd" | "launchd";
    options?: Parameters<typeof updateCommand>[0];
    ancestor?: boolean;
    git?: boolean;
  }>([
    { platform: "linux", env: { INVOCATION_ID: "gateway-invocation" }, supervisor: "systemd" },
    { platform: "linux", env: { JOURNAL_STREAM: "8:123" }, supervisor: "systemd" },
    {
      platform: "linux",
      env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      supervisor: "systemd",
    },
    { platform: "linux", env: {}, supervisor: "systemd", ancestor: true },
    {
      platform: "linux",
      env: { INVOCATION_ID: "gateway-invocation" },
      supervisor: "systemd",
      options: { tag: "./candidate.tgz" },
    },
    {
      platform: "linux",
      env: { INVOCATION_ID: "gateway-invocation" },
      supervisor: "systemd",
      options: { channel: "extended-stable" },
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
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway"]);
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

  it.each(["running", "stopped", "unavailable", "dead inherited PID"])(
    "checks inherited Gateway liveness with incomplete ancestry and %s service inspection",
    async (scenario) => {
      const root = await mockPackageInstallAtCaseDir();
      primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: scenario === "stopped" ? "stopped" : "running",
        pid: gatewayFixturePid,
        state: scenario === "stopped" ? "stopped" : "running",
      });
      if (scenario === "unavailable") {
        serviceReadRuntime.mockRejectedValue(new Error("fixture service manager unavailable"));
      }
      if (scenario === "dead inherited PID") {
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
      mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));

      const env = {
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(
          scenario === "dead inherited PID" ? 2_000_000_000 : process.ppid,
        ),
      };
      if (scenario === "dead inherited PID") {
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
          expect.objectContaining({
            failureFacts: [expect.objectContaining({ code: "service-ancestry-unverified" })],
          }),
        ]),
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(serviceStop).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    },
  );
});
