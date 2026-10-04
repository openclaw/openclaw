/**
 * Tests managed-service update handoff behavior exposed by gateway methods.
 */
// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import {
  createSpawnMock,
  useManagedServiceHandoffLifecycleFixture,
} from "./update-managed-service-handoff-fixture.test-support.js";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import { registerManagedCampaignFailureTests } from "./update-managed-service-handoff-campaign.test-support.js";
import {
  cleanupStaleManagedServiceUpdateHandoffs,
  MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX,
} from "./update-managed-service-handoff-cleanup.js";
import {
  isManagedServiceInspectionCommand,
  registerManagedHandoffOwnerTests,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { pathExists } from "./update-managed-service-native.test-support.js";
import { recordUpdateRunStep } from "./update-run-ledger.js";

const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-lifecycle-${process.pid}`);
const { forceKillChildProcessTreeMock, spawnMock, tempDirs, runManagedServiceManagerBoundary } =
  useManagedServiceHandoffLifecycleFixture();
const nodeTempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createUserSystemdFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-"));
  tempDirs.add(home);
  const unitPath = path.join(home, ".config", "systemd", "user", "openclaw-gateway.service");
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/true\n");
  const systemdRunPath = path.join(home, "systemd-run");
  await fs.writeFile(systemdRunPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    systemdRunPath,
    env: { HOME: home, PATH: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
  };
}

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedHandoffOwnerTests(runManagedServiceManagerBoundary, itUnix, expect);

  itUnix.each(["addressed-unsafe", "rollback", "unsafe", "validation"] as const)(
    "coordinates CLI %s outcomes and preserves the notice destination",
    async (outcome) => {
      const rollback = outcome === "rollback";
      const origin =
        outcome === "addressed-unsafe"
          ? {
              sessionKey: "agent:ops:telegram:group:room",
              deliveryContext: {
                channel: "telegram",
                to: "room",
                accountId: "bot",
                threadId: "topic-7",
              },
            }
          : undefined;
      const result = await runManagedServiceManagerBoundary("systemd", {
        trigger: "cli",
        ...(origin ? { origin } : {}),
        ledger: true,
        controlDisconnect: "transferred",
        ...(outcome === "validation"
          ? { validationResult: "failed", helperExitCode: 1 }
          : {
              ...(!origin ? { rollbackRestoration: rollback } : {}),
              updaterExitCode: 79,
              helperExitCode: rollback ? 1 : 79,
              updaterResult: {
                status: "error",
                mode: "npm",
                reason: "restart-unhealthy",
                ...(!origin
                  ? {
                      before: { version: "1.0.0" },
                      after: { version: "1.0.0" },
                    }
                  : {}),
                recovery: rollback
                  ? { serviceRestartSafe: true, packageRollbackVerified: true, version: "1.0.0" }
                  : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
              },
            }),
      });
      expect(result.run, result.log).toMatchObject({
        status: rollback ? "rolled-back" : "failed",
        phase: "finished",
      });
      if (rollback) {
        expect(result.state).toMatchObject({
          restored: true,
          healthProbeCount: 1,
          expectedVersion: "1.0.0",
          recoveryAllowance: "1",
        });
        expect(result.run?.verification).toMatchObject({
          runningVersion: "1.0.0",
          versionMatch: true,
          settled: true,
        });
      } else {
        expect(result.state.restored).toBeUndefined();
        if (!origin) {
          expect(
            result.commands.some((command) =>
              /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command),
            ),
          ).toBe(false);
        }
      }
      if (outcome === "unsafe") {
        expect(result.log).toContain("keep the gateway stopped");
      }
      if (outcome === "validation") {
        expect(result.commands).toEqual([]);
      }
      if (origin) {
        expect(result.state.parked).toBe(true);
        expect(result.sentinel).toMatchObject({
          payload: {
            sessionKey: origin.sessionKey,
            deliveryContext: { channel: "telegram", to: "room", accountId: "bot" },
            threadId: "topic-7",
            stats: { runId: result.run?.runId, handoffId: "systemd-boundary" },
          },
        });
      } else {
        expect(result.sentinel).toBeNull();
      }
    },
  );

  itUnix.each([
    { kind: "systemd", reply: "acknowledged", profileRequester: false },
    { kind: "systemd", reply: "stalled", profileRequester: false },
    { kind: "systemd", reply: "rejected", profileRequester: false },
    { kind: "systemd", reply: "acknowledged", profileRequester: true },
    { kind: "systemd", reply: "rejected", profileRequester: true },
    { kind: "systemd", reply: "stalled", profileRequester: true },
    { kind: "systemd", reply: "disconnected", profileRequester: true },
    { kind: "launchd", reply: "acknowledged", profileRequester: true },
    { kind: "launchd", reply: "rejected", profileRequester: true },
  ] as const)(
    "bounds the park notice and requires profile acknowledgement: $kind/$reply/profile=$profileRequester",
    async ({ kind, reply, profileRequester }) => {
      const accepted = reply === "acknowledged";
      const result = await runManagedServiceManagerBoundary(kind, {
        ...(profileRequester
          ? { ledger: true, profileRequester, helperExitCode: accepted ? 0 : 1 }
          : {}),
        controlDisconnect: "transferred",
        beforeParkNotice: reply,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      if (profileRequester) {
        expect(result.parkAdmitted, result.log).toBe(accepted);
        expect(result.state.parked === true, result.log).toBe(accepted);
        if (!accepted) {
          expect(result.commands.every(isManagedServiceInspectionCommand), result.log).toBe(true);
          expect(result.parentSignal, result.log).toBeNull();
          expect(result.log).toContain("owner_required");
        }
      } else {
        expect(
          result.commands.some((command) => command.includes("stop openclaw-gateway.service")),
        ).toBe(true);
        expect(result.state).toMatchObject({ parked: true, stopCompleted: true });
        expect(result.parkAdmitted).toBe(false);
        expect(result.log.includes("pre-park notice timed out after 10 seconds")).toBe(
          reply === "stalled",
        );
        expect(result.log.includes("pre-park notice failed")).toBe(reply === "rejected");
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) => [
      { kind, selectedDriver: false },
      { kind, selectedDriver: true },
    ]),
  )(
    "preserves $kind handoff history with selected driver=$selectedDriver",
    async ({ kind, selectedDriver }) => {
      const { run, state, sensitiveFilesRemoved } = await runManagedServiceManagerBoundary(kind, {
        ...(selectedDriver ? { controlDisconnect: "transferred", selectedDriver: "2026.9.3" } : {}),
        ledger: true,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      if (selectedDriver) {
        expect(state).toMatchObject({
          parked: true,
          selectedDriverVersion: "2026.9.3",
          selectedDriverArgs: ["update", "--yes", "--json"],
        });
        expect(run).toMatchObject({ status: "succeeded", phase: "finished" });
        expect(sensitiveFilesRemoved).toBe(true);
      } else {
        const steps = run?.steps.map((step) => step.step);
        expect(steps).toEqual(expect.arrayContaining(["staging", "validating"]));
        expect(steps).not.toContain("activating");
        expect(run?.steps).toContainEqual(
          expect.objectContaining({ step: "service-stop", status: "completed" }),
        );
      }
    },
  );

  itUnix(
    "retains terminal parent exit when a later liveness probe would be inconclusive",
    async () => {
      const { log, state, sensitiveFilesRemoved } = await runManagedServiceManagerBoundary(
        "launchd",
        {
          controlDisconnect: "transferred",
          terminalParentExitProbe: true,
          updaterExitCode: 7,
          helperExitCode: 7,
          updaterResult: {
            status: "error",
            mode: "npm",
            recovery: { serviceRestartSafe: true, version: "1.0.0" },
          },
        },
      );
      expect(log).toContain("terminal parent exit observed");
      expect(log).not.toContain("parent probed after terminal exit");
      expect(state).toMatchObject({ parked: true, restored: true, healthProbeCount: 1 });
      expect(sensitiveFilesRemoved).toBe(true);
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      [false, true].map((recover) => ({ kind, recover })),
    ),
  )(
    "keeps $kind serving through ten minutes of validation before activation and preserves relative inputs (recovery=$recover)",
    async ({ kind, recover }) => {
      const { commands, state, sensitiveFilesRemoved } = await runManagedServiceManagerBoundary(
        kind,
        {
          controlDisconnect: "transferred",
          validationClockAdvanceMs: 10 * 60_000,
          relativeInput: true,
          updaterExitCode: recover ? 7 : 0,
          helperExitCode: recover ? 7 : 0,
          updaterResult: {
            status: recover ? "error" : "ok",
            mode: "npm",
            ...(recover ? { recovery: { serviceRestartSafe: true, version: "1.0.0" } } : {}),
          },
        },
      );
      expect(commands.some((command) => /\b(stop|bootout)\b/.test(command))).toBe(true);
      expect(state).toMatchObject({ parked: true });
      if (recover) {
        expect(state).toMatchObject({
          restored: true,
          healthProbeCount: 1,
          triageCalls: 1,
          triageObservedRestored: true,
          triageObservedRecovery: true,
        });
      }
      expect(sensitiveFilesRemoved).toBe(true);
    },
  );

  itUnix("carries the activation acknowledgement through the spawn fallback runner", async () => {
    const { state } = await runManagedServiceManagerBoundary("systemd", {
      controlDisconnect: "transferred",
      runnerFallback: true,
      updaterExitCode: 0,
      updaterResult: { status: "ok", mode: "npm" },
    });
    expect(state).toMatchObject({ parked: true, stopCompleted: true });
  });

  itUnix.each(["systemd", "launchd"] as const)(
    "joins the selected legacy driver's pending %s stop after parent expiry with unverified recovery",
    async (kind) => {
      const { commands, state, run, log, stopSettlement } = await runManagedServiceManagerBoundary(
        kind,
        {
          controlDisconnect: "transferred",
          selectedDriver: "2026.9.3",
          expireParentWhileStopPending: true,
          originalRecovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          systemdStopDelayMs: 2_500,
          launchdTeardown: { bootoutDelayMs: 2_500 },
          ledger: true,
          helperExitCode: 1,
        },
      );
      expect(stopSettlement).toMatchObject({
        pid: expect.any(Number),
        closed: true,
        code: 0,
        signal: null,
        parentKilledWhileStopPending: true,
        failedWhileStopPending: false,
      });
      expect(state).toMatchObject(
        kind === "systemd" ? { stopCompleted: true } : { bootoutCompleted: true },
      );
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /\b(start|enable|bootstrap|kickstart)\b/.test(command)),
      ).toBe(false);
      expect(run).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "managed-service-handoff-restore-failed",
      });
      expect(log).toContain("managed update parent exit exceeded the activation deadline");
      expect(log).toContain("recovery refused: original runtime identity could not be verified");
    },
  );

  itUnix(
    "finalizes through the installed runtime after replacing its module graph within the recovery budget",
    async () => {
      const { run, log, state } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect: "transferred",
        ledger: true,
        replaceLedgerWriter: true,
        finalizationWorkMs: 65_000,
        recoveryTimeoutMs: 120_000,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      expect(run).toMatchObject({ status: "succeeded", phase: "finished" });
      expect(state.finalizationBudgetMs).toBe(120_000);
      expect(log).not.toContain("the previous runtime must not finalize the candidate");
      expect(log).toContain("managed update finalize command exited code=0");
    },
  );

  itUnix.each(["failed", "skipped"] as const)(
    "finishes the update run without touching the serving generation when validation finishes %s",
    async (validationResult) => {
      const { commands, parentSignal, log, run } = await runManagedServiceManagerBoundary(
        "systemd",
        {
          controlDisconnect: "transferred",
          ledger: true,
          validationResult,
          validationClockAdvanceMs: 10 * 60_000,
          helperExitCode: validationResult === "failed" ? 1 : 0,
        },
      );
      expect(run).toMatchObject({
        status: validationResult,
        phase: "finished",
        reason:
          validationResult === "failed" ? "managed-service-handoff-failed" : "already-current",
        finishedAtMs: expect.any(Number),
      });
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(log).not.toContain("gateway service recovery");
    },
  );

  itUnix(
    "rechecks revoked chat ownership after validation before stopping the Gateway",
    async () => {
      const { commands, parentSignal, sentinel } = await runManagedServiceManagerBoundary(
        "systemd",
        {
          controlDisconnect: "transferred",
          requester: { channel: "slack", accountId: "primary", senderId: "owner" },
          revokeWhileValidating: true,
          helperExitCode: 1,
        },
      );
      expect(commands.filter((command) => !isManagedServiceInspectionCommand(command))).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "owner_required" } },
      });
    },
  );

  itUnix("preserves the Gateway refusal when cancellation settles its run", async () => {
    const reason = "managed-service-handoff-failed";
    const message = "managed update ownership transfer failed";
    const { commands, parentSignal, run, sentinel } = await runManagedServiceManagerBoundary(
      "systemd",
      {
        ledger: true,
        controlDisconnect: "unarmed",
        beforeDisconnect: (admittedRun, env) => {
          recordUpdateRunStep(
            expectDefined(admittedRun, "admitted update run").runId,
            {
              step: "requested",
              status: "failed",
              reason,
              failureFacts: [{ check: reason, code: reason, message }],
            },
            { env },
          );
        },
      },
    );
    expect(commands).toEqual([]);
    expect(parentSignal).toBeNull();
    expect(run).toMatchObject({
      status: "failed",
      reason,
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "requested",
          status: "failed",
          failureFacts: [{ check: reason, code: reason, message }],
        }),
      ]),
    });
    expect(sentinel).toMatchObject({ payload: { status: "error", stats: { reason } } });
  });

  registerManagedCampaignFailureTests(runManagedServiceManagerBoundary, itUnix);

  itUnix.each([
    ["systemd", "validation"],
    ["systemd", "requester"],
    ["systemd", "inspection"],
    ["launchd", "requester"],
    ["launchd", "inspection"],
  ] as const)(
    "cancels %s updates at %s without stopping the serving generation",
    async (kind, boundary) => {
      const { commands, parentSignal, state, sentinel, log } =
        await runManagedServiceManagerBoundary(kind, {
          controlDisconnect: "transferred",
          ...(boundary === "validation"
            ? { cancelDuringValidation: true }
            : { cancelAtActivation: boundary }),
          ...(boundary === "requester"
            ? { requester: { channel: "synthetic", senderId: "owner" } }
            : {}),
        });
      expect(parentSignal).toBeNull();
      if (boundary === "validation") {
        expect(commands).toEqual([]);
        expect(log).not.toContain("gateway service recovery");
        expect(log).toContain("managed update helper completed code=0");
      } else {
        expect(commands.filter((command) => !/\b(?:show|print)\b/u.test(command))).toEqual([]);
        expect(state.parked).toBeUndefined();
        expect(state.disabled).toBeUndefined();
        expect(sentinel).toMatchObject({
          payload: { status: "skipped", stats: { reason: "managed-service-handoff-cancelled" } },
        });
      }
    },
  );

  itUnix.each(["expired", "unarmed", "dead-parent"] as const)(
    "does not stop or update the service after %s admission",
    async (admission) => {
      const { commands, parentSignal, sentinel } = await runManagedServiceManagerBoundary(
        "systemd",
        admission === "expired"
          ? { parentExitTimeoutMs: 100 }
          : { controlDisconnect: admission, updaterExitCode: 0 },
      );
      expect(commands).toEqual([]);
      if (admission === "expired") {
        expect(parentSignal).toBeNull();
      }
      expect(sentinel).toMatchObject({
        payload: { status: "skipped", stats: { reason: "managed-service-handoff-cancelled" } },
      });
    },
  );

  it.each([
    ["spawn error", { code: "ENOENT" }],
    [
      "launcher exit",
      { message: "managed update handoff exited before signaling readiness (code=1, signal=null)" },
    ],
    [
      "readiness timeout",
      { message: "managed update handoff did not signal readiness within 30 seconds" },
    ],
  ] as const)("rejects %s and cleans up the sensitive handoff", async (failure, expected) => {
    if (failure === "readiness timeout") {
      vi.useFakeTimers();
    }
    const child = createSpawnMock();
    spawnMock.mockImplementationOnce(() => {
      // Readiness listeners and the deadline are installed after spawn returns.
      process.nextTick(() => {
        if (failure === "spawn error") {
          child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        } else if (failure === "launcher exit") {
          child.emit("exit", 1, null);
        } else {
          vi.advanceTimersByTime(30_000);
        }
      });
      return child;
    });
    let env: NodeJS.ProcessEnv | undefined;
    if (failure === "launcher exit") {
      env = (await createUserSystemdFixture()).env;
    }
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const resultPromise = startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      timeoutMs: 30_000,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath:
        failure === "spawn error" ? "/definitely/missing/openclaw-node" : "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: failure === "launcher exit" ? "systemd" : undefined,
      env,
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });
    await expect(resultPromise).rejects.toMatchObject(expected);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args.at(-2) ?? "");
    tempDirs.add(handoffDir);

    if (failure === "readiness timeout") {
      expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    }
    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it
    .runIf(process.platform === "darwin")
    .each([
      "versioned-service",
      "direct-supported",
      "direct-missing",
      "wrapper-missing",
      "wrapper-present",
    ] as const)("selects or refuses the saved Gateway runtime: %s", async (scenario) => {
    const home = nodeTempDirs.make("openclaw-handoff-node-");
    const originalExecPath = process.execPath;
    const wrapperScenario = scenario === "wrapper-missing" || scenario === "wrapper-present";
    const replacement = path.join(home, wrapperScenario ? "node" : "node24.20.0");
    const removed =
      wrapperScenario || scenario === "versioned-service"
        ? path.join(home, "removed-node")
        : path.join(home, "old", "node");
    const wrapper = path.join(home, "gateway-wrapper");
    if (scenario !== "direct-missing") {
      await fs.symlink(originalExecPath, replacement);
    }
    if (wrapperScenario) {
      await fs.writeFile(
        wrapper,
        `#!/bin/sh\nexec '${replacement}' /opt/openclaw/openclaw.mjs "$@"\n`,
        { mode: 0o755 },
      );
    }
    const runtimePaths = await import("../daemon/runtime-paths.js");
    const launchdRuntime = await import("../daemon/launchd-runtime.js");
    const probe = vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(
      scenario === "direct-supported" || wrapperScenario
        ? {
            path: replacement,
            status: "supported",
            version: process.versions.node,
            sqliteVersion: "3.51.0",
            nodeSharedSqlite: false,
            sqliteProbe: { available: true, version: "3.51.0", text: true, blob: true, json: true },
          }
        : null,
    );
    const service = vi.spyOn(launchdRuntime, "readLaunchAgentProgramArguments").mockResolvedValue({
      programArguments: wrapperScenario
        ? [wrapper, "gateway", "--port", "18789"]
        : [
            scenario === "versioned-service" ? replacement : removed,
            "/opt/openclaw/openclaw.mjs",
            "gateway",
          ],
    });
    process.execPath = scenario === "wrapper-present" ? originalExecPath : removed;
    const beforePark = vi.fn(async () => {});
    try {
      const { startManagedServiceUpdateHandoff } =
        await import("./update-managed-service-handoff.js");
      const handoff = startManagedServiceUpdateHandoff({
        root: MOCK_INSTALL_ROOT,
        restartDrainTimeoutMs: 300_000,
        parentPid: process.pid,
        argv1: "/opt/openclaw/openclaw.mjs",
        env: { HOME: home, PATH: home },
        supervisor: "launchd",
        ...(wrapperScenario ? { beforePark } : {}),
        meta: { sessionKey: "agent:test:webchat:dm:user-123" },
      });
      if (scenario === "direct-missing" || scenario === "wrapper-missing") {
        await expect(handoff).rejects.toThrow(removed);
        await expect(handoff).rejects.toThrow("openclaw gateway install --force");
        expect(spawnMock).not.toHaveBeenCalled();
        if (wrapperScenario) {
          expect(beforePark).not.toHaveBeenCalled();
        }
      } else {
        await expect(handoff).resolves.toMatchObject({ status: "started" });
        const [command, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
        tempDirs.add(path.dirname(expectDefined(args[0], "handoff script")));
        expect(command).toBe(scenario === "wrapper-present" ? originalExecPath : replacement);
        if (scenario === "versioned-service") {
          const helperParams = JSON.parse(
            await fs.readFile(expectDefined(args[1], "handoff parameters"), "utf8"),
          ) as {
            commandArgv: string[];
            recoveryCommandArgv: string[];
            triageCommandArgv: string[];
          };
          expect(helperParams.commandArgv[0]).toBe(replacement);
          expect(helperParams.recoveryCommandArgv[0]).toBe(replacement);
          expect(helperParams.triageCommandArgv[0]).toBe(replacement);
        }
      }
    } finally {
      process.execPath = originalExecPath;
      probe.mockRestore();
      service.mockRestore();
    }
  });

  itUnix("refuses a removed Node without a replacement before parking the Gateway", async () => {
    const originalExecPath = process.execPath;
    const runtimePaths = await import("../daemon/runtime-paths.js");
    const probe = vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
    process.execPath = path.join(os.tmpdir(), `missing-openclaw-node-${process.pid}`);
    try {
      const { startManagedServiceUpdateHandoff } =
        await import("./update-managed-service-handoff.js");
      await expect(
        startManagedServiceUpdateHandoff({
          root: MOCK_INSTALL_ROOT,
          restartDrainTimeoutMs: 300_000,
          parentPid: process.pid,
          env: { PATH: "" },
          meta: { sessionKey: "agent:test:webchat:dm:user-123" },
        }),
      ).rejects.toThrow("openclaw gateway install --force");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      process.execPath = originalExecPath;
      probe.mockRestore();
    }
  });

  it.each([
    { supervisors: [undefined], timeoutMs: 1_800_000 },
    { supervisors: ["systemd"], timeoutMs: undefined },
    { supervisors: ["systemd"], timeoutMs: 1_800_000 },
    { supervisors: ["launchd", "schtasks"], timeoutMs: 1_800_000 },
  ] as const)(
    "preserves launch metadata for $supervisors (timeout=$timeoutMs)",
    async ({ supervisors, timeoutMs }) => {
      const { startManagedServiceUpdateHandoff } =
        await import("./update-managed-service-handoff.js");
      const serviceIdentityEnv = {
        OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-test.service",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway",
      } satisfies NodeJS.ProcessEnv;
      const supervisorEnv = Object.fromEntries(
        SUPERVISOR_HINT_ENV_VARS.map((key) => [key, "supervised"]),
      ) as NodeJS.ProcessEnv;

      for (const supervisor of supervisors) {
        const systemd = supervisor === "systemd" ? await createUserSystemdFixture() : undefined;
        if (systemd) {
          const spawnNormally = spawnMock.getMockImplementation()!;
          spawnMock.mockImplementationOnce((command: string, args: string[], options: unknown) => {
            const params = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
            const db = new DatabaseSync(params.updateLeaseDatabasePath, { readOnly: true });
            try {
              expect(
                db.prepare("SELECT COUNT(*) AS count FROM managed_update_handoffs").get(),
              ).toEqual({ count: 0 });
            } finally {
              db.close();
            }
            expect(params.updateLeaseDatabaseIdentity.databasePath).toBe(
              params.updateLeaseDatabasePath,
            );
            return spawnNormally(command, args, options);
          });
        }
        const env = systemd
          ? { ...systemd.env, INVOCATION_ID: "gateway-invocation", KEEP_ME: "1" }
          : supervisor === "launchd"
            ? { OPENCLAW_LAUNCHD_LABEL: "test.gateway", HOME: "/Users/test" }
            : supervisor === "schtasks"
              ? { OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway" }
              : { ...supervisorEnv, ...serviceIdentityEnv, KEEP_ME: "1" };
        const result = await startManagedServiceUpdateHandoff({
          root: MOCK_INSTALL_ROOT,
          timeoutMs,
          ...(systemd
            ? { recoveryTimeoutMs: 45 * 60_000, handoffId: "handoff-123", channel: "beta" }
            : {}),
          restartDrainTimeoutMs: 300_000,
          restartDelayMs: 500,
          parentPid: process.pid,
          execPath: "/usr/local/bin/node",
          argv1: "/opt/openclaw/openclaw.mjs",
          supervisor,
          env,
          meta: {
            ...(systemd ? { handoffId: "handoff-123" } : {}),
            sessionKey: "agent:test:webchat:dm:user-123",
            ...(!supervisor || systemd ? { continuationMessage: "continue after restart" } : {}),
          },
        });

        expect(result.status).toBe("started");
        if (!supervisor || systemd) {
          expect(spawnMock).toHaveBeenCalledTimes(1);
        }
        const [command, args, options] = spawnMock.mock.calls.at(-1) as unknown as [
          string,
          string[],
          { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
        ];
        const scriptIndex = systemd ? 5 : 0;
        tempDirs.add(path.dirname(args[scriptIndex] ?? result.logPath));
        const helperParams = JSON.parse(
          await fs.readFile(args[scriptIndex + 1] ?? "", "utf-8"),
        ) as {
          metaPath: string;
          triageContextPath: string;
          commandArgv?: string[];
          handoffId?: string;
          serviceRecovery?: unknown;
          recoveryTimeoutMs: number;
        };
        if (systemd) {
          expect(command).toBe(systemd.systemdRunPath);
          expect(args.slice(0, 4)).toEqual([
            "--user",
            "--scope",
            "--collect",
            "--unit=openclaw-update-handoff-123.scope",
          ]);
          expect(args.slice(4, 7)).toEqual([
            "/usr/local/bin/node",
            expect.stringMatching(/handoff\.cjs$/u),
            expect.stringMatching(/handoff\.json$/u),
          ]);
          expect(helperParams.serviceRecovery).toEqual({
            kind: "systemd",
            unit: "openclaw-gateway.service",
          });
          expect(helperParams.commandArgv).toEqual([
            "/usr/local/bin/node",
            "/opt/openclaw/openclaw.mjs",
            "update",
            "--yes",
            "--json",
            "--channel",
            "beta",
            ...(timeoutMs === undefined ? [] : ["--timeout", "1800"]),
          ]);
          expect(helperParams.recoveryTimeoutMs).toBe(45 * 60_000);
          expect(helperParams.handoffId).toBe("handoff-123");
          expect(options.detached).toBe(true);
          expect(options.env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
          expect(options.env.INVOCATION_ID).toBeUndefined();
        } else if (!supervisor) {
          for (const [key, value] of Object.entries(serviceIdentityEnv)) {
            expect(options.env[key]).toBe(value);
          }
          for (const key of SUPERVISOR_HINT_ENV_VARS.filter(
            (envKey) => !(envKey in serviceIdentityEnv),
          )) {
            expect(options.env[key]).toBeUndefined();
          }
          expect(options.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]).toBe(helperParams.metaPath);
          expect(JSON.parse(await fs.readFile(helperParams.metaPath, "utf8"))).toMatchObject({
            meta: { triageContextPath: helperParams.triageContextPath },
          });
        } else {
          expect(helperParams.serviceRecovery).toEqual(
            supervisor === "launchd"
              ? {
                  kind: "launchd",
                  uid: typeof process.getuid === "function" ? process.getuid() : 501,
                  label: "test.gateway",
                  plistPath: path.posix.join(
                    "/Users/test",
                    "Library",
                    "LaunchAgents",
                    "test.gateway.plist",
                  ),
                }
              : { kind: "schtasks", taskName: "OpenClaw Test Gateway" },
          );
          const child = spawnMock.mock.results.at(-1)?.value as
            | ReturnType<typeof createSpawnMock>
            | undefined;
          child?.emit("exit", 0, null);
        }
        if (!supervisor || systemd) {
          expect(options.env.KEEP_ME).toBe("1");
          expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
        }
      }
    },
  );

  itUnix("parks and restores the exact user-systemd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      cancelAfterPark: true,
    });
    const verbs = commands.map((command) =>
      command.split(" ").find((part) => ["show", "stop", "reset-failed", "start"].includes(part)),
    );

    expect(verbs).toEqual(["show", "stop", "show", "start", "show"]);
    expect(commands.every((command) => command.startsWith("--user "))).toBe(true);
    expect(commands[0]).toContain(
      "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID",
    );
    expect(commands[1]).toContain("stop openclaw-gateway.service");
    expect(state).toMatchObject({ parked: true, restored: true });
    expect(state.guardedRestart).toBeUndefined();
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: {
          reason: "managed-service-handoff-cancelled",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  it("sweeps stale handoff temp directories while keeping fresh handoff logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-cleanup-test-"));
    tempDirs.add(tmpDir);
    const staleDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}stale`);
    const freshDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}fresh`);
    const unrelatedDir = path.join(tmpDir, "openclaw-other-temp");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(unrelatedDir, { recursive: true });
    const now = Date.now();
    const staleTime = new Date(now - 25 * 60 * 60_000);
    await fs.utimes(staleDir, staleTime, staleTime);

    await expect(
      cleanupStaleManagedServiceUpdateHandoffs({
        tmpDir,
        nowMs: now,
        ttlMs: 24 * 60 * 60_000,
      }),
    ).resolves.toBe(1);

    await expect(pathExists(staleDir)).resolves.toBe(false);
    await expect(pathExists(freshDir)).resolves.toBe(true);
    await expect(pathExists(unrelatedDir)).resolves.toBe(true);
  });
});
