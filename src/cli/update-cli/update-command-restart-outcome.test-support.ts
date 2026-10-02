import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { expect, it, vi, type Mock } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as processSpawner from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import * as startRepair from "../daemon-cli/start-repair.js";
import type { UpdateCommandOptions } from "./shared.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  type createServiceActivationFixture,
  readyRecoveryHealth,
  serviceUpdateResult,
} from "./update-command-service-recovery.test-support.js";
import type { InstallRootTransitionFixture } from "./update-command-service-transition.test-support.js";
import {
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service.js";

export function registerRestartOutcomeTests(
  getFixture: () => {
    root: string;
    run: NonNullable<UpdateCommandOptions["run"]>;
    servingOwner: Awaited<ReturnType<typeof createServiceActivationFixture>>["servingOwner"];
    mocks: Pick<
      InstallRootTransitionFixture["mocks"],
      "child" | "health" | "configSnapshot" | "capability" | "command" | "running"
    > & {
      restart: Mock<() => Promise<{ outcome: "completed" }>>;
      terminateStale: Mock<
        typeof import("../../infra/restart-stale-pids.js").terminateStaleGatewayPids
      >;
      writeJson: Mock;
    };
  },
) {
  it.each([false, true])(
    "uses the native restart owner after preparing a writable unknown-version target (revoked=%s)",
    async (revoked) => {
      const { root, run, mocks } = getFixture();
      vi.spyOn(os, "tmpdir").mockReturnValue(root);
      const unownedSpawn = vi
        .spyOn(processSpawner, "spawnCommand")
        .mockRejectedValue(new Error("Unowned native restart refused"));
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      const result: UpdateRunResult = serviceUpdateResult(root);
      const prepared = await prepareUpdateRestart(
        {
          root,
          result,
          preManagedServiceStop: before,
          shouldRestart: true,
          updateStepTimeoutMs: 1_000,
          assertCurrent: () => run.executorFence?.assertCurrent(),
        },
        await readConfigFileSnapshot(),
      );
      expect(prepared.refreshGatewayServiceEnv).toBe(true);
      let current = true;
      const executorFence = {
        assertCurrent() {
          if (!current) {
            throw new Error("Original update owner revoked");
          }
        },
      };
      mocks.configSnapshot.mockImplementationOnce(async () => {
        current = !revoked;
      });
      mocks.child.mockImplementation(async (argv) => {
        if (argv.includes("restart")) {
          const program = new Command().exitOverride();
          addGatewayServiceCommands(program.command("gateway"));
          await program.parseAsync(argv.slice(2), { from: "user" });
        } else {
          expect(argv).toContain("install");
        }
        return commandResult({
          stdout: argv.includes("restart")
            ? JSON.stringify(mocks.writeJson.mock.lastCall?.[0])
            : JSON.stringify({ action: "install", ok: true }),
        });
      });
      const onVerified = vi.fn();
      const activation = maybeRestartService({
        ...prepared,
        shouldRestart: true,
        result,
        opts: { json: true, run: { ...run, executorFence } },
        refreshServiceEnv: prepared.refreshGatewayServiceEnv,
        serviceEnv: prepared.gatewayServiceEnv,
        serviceInstallEnv: prepared.gatewayServiceInstallEnv,
        timeoutMs: 1_000,
        onVerified,
      });
      if (revoked) {
        await expect(activation).rejects.toThrow("Original update owner revoked");
        expect(mocks.restart).not.toHaveBeenCalled();
        expect(onVerified).not.toHaveBeenCalled();
        expect(result.steps).toEqual([]);
      } else {
        await expect(activation).resolves.toBe("ok");
        expect(mocks.restart).toHaveBeenCalledOnce();
        expect(onVerified).toHaveBeenCalledOnce();
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "gateway verification", exitCode: 0 }),
        );
      }
      expect(unownedSpawn).not.toHaveBeenCalled();
      expect(mocks.child.mock.calls.map(([argv]) => argv[3])).toEqual(
        revoked ? ["install"] : ["install", "restart"],
      );
    },
  );

  it.each(["git-to-npm restart", "failed-update recovery", "revoked recovery"] as const)(
    "revalidates a collected stopped systemd unit during %s",
    async (scenario) => {
      const { root, run, mocks } = getFixture();
      const switchingInstall = scenario === "git-to-npm restart";
      if (switchingInstall) {
        await Promise.all(
          [".git", "src", "extensions"].map((directory) => fs.mkdir(path.join(root, directory))),
        );
        mocks.capability.mockResolvedValue({ kind: "writable" });
      }
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: switchingInstall ? "git" : "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      let command = await mocks.command(process.env);
      if (!command) {
        throw new Error("Missing managed service fixture command");
      }
      expect(before.stopped).toBe(true);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Original update owner revoked");
        }
      };
      run.executorFence = { assertCurrent };
      mocks.command.mockImplementation(async (_env, options) => {
        if (options?.requireLoaded && !mocks.running) {
          if (!options.loadForInspection) {
            throw new Error("Effective systemd service command could not be inspected.");
          }
          expect(options.loadForInspection.managerUid).toBe(before.serviceManagerUid);
          current = scenario !== "revoked recovery";
          options.loadForInspection.assertCurrent();
        }
        return command;
      });
      if (switchingInstall) {
        expect(await summarizeGatewayServiceLayout(command)).toMatchObject({
          packageRootReal: root,
          entrypointSourceCheckout: true,
        });
        const packageRoot = path.join(root, "npm", "lib", "node_modules", "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        await fs.mkdir(path.dirname(packageEntry), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: VERSION }),
        );
        await fs.writeFile(packageEntry, "export {};\n");
        // Model the persisted output of candidate Doctor before service revalidation.
        const configPath = path.join(root, ".openclaw", "openclaw.json");
        const config = JSON.parse(await fs.readFile(configPath, "utf8"));
        config.update = { channel: "stable" };
        await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
        const beforeInstall = command;
        mocks.child.mockImplementation(async (argv) => {
          expect(argv).toContain(packageEntry);
          expect(argv).toContain("install");
          expect(argv).toContain("--force");
          expect(command).toBe(beforeInstall);
          command = {
            ...beforeInstall,
            programArguments: [process.execPath, packageEntry, "gateway", "--port", "19305"],
          };
          mocks.running = true;
          return commandResult({
            stdout: JSON.stringify({ action: "install", ok: true }),
          });
        });
        const result: UpdateRunResult = serviceUpdateResult(packageRoot, {
          before: { version: VERSION },
          after: { version: VERSION },
        });
        const prepared = await prepareUpdateRestart(
          {
            root,
            result,
            preManagedServiceStop: before,
            shouldRestart: true,
            updateStepTimeoutMs: 1_000,
            assertCurrent,
          },
          await readConfigFileSnapshot(),
        );
        expect(prepared.serviceUpdateVerdict).toMatchObject({
          kind: "owned",
          root,
          requiresInstallRootRefresh: true,
        });
        expect(prepared.refreshGatewayServiceEnv).toBe(true);
        await expect(
          maybeRestartService({
            ...prepared,
            shouldRestart: true,
            result,
            opts: { json: true, run },
            refreshServiceEnv: prepared.refreshGatewayServiceEnv,
            serviceEnv: prepared.gatewayServiceEnv,
            serviceInstallEnv: prepared.gatewayServiceInstallEnv,
            timeoutMs: 1_000,
          }),
        ).resolves.toBe("ok");
        expect(mocks.child).toHaveBeenCalledOnce();
        expect(await summarizeGatewayServiceLayout(command)).toMatchObject({
          packageRootReal: packageRoot,
          entrypointSourceCheckout: false,
        });
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).update.channel).toBe("stable");
      } else {
        const recovery = maybeRestartServiceAfterFailedMutableUpdate({
          preManagedServiceStop: before,
          updateRun: run,
          recovery: { serviceRestartSafe: true, version: VERSION },
          jsonMode: true,
        });
        if (scenario === "revoked recovery") {
          await expect(recovery).rejects.toThrow("Original update owner revoked");
          expect(mocks.child).not.toHaveBeenCalled();
          expect(mocks.running).toBe(false);
          return;
        }
        await expect(recovery).resolves.toBe("healthy");
      }
      expect(mocks.running).toBe(true);
      expect(mocks.health).toHaveBeenCalled();
    },
  );

  it.each([
    ["preserved health", "restart-health-failed"],
    ["native refusal", "failed"],
    ["unexpected check", "failed"],
    ["retry refusal", "failed"],
    ["writable health", "restart-health-failed"],
    ["writable retry health", "restart-health-failed"],
    ["progressing cap", "readiness-pending"],
    ["cap then healthy", "ok"],
    ["writable progressing cap", "readiness-pending"],
  ])(
    "carries the real lifecycle's serialized %s result through a child process",
    async (scenario, expected) => {
      const { root, run, mocks, servingOwner } = getFixture();
      await servingOwner.publish();
      const writable = scenario.startsWith("writable ");
      const progressing = scenario.includes("cap");
      const serviceEnv = { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" };
      const repair = vi
        .spyOn(startRepair, "repairLoadedGatewayServiceForStart")
        .mockRejectedValue(new Error("Updater restarts must preserve the definition."));
      if (writable) {
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
        mocks.capability.mockResolvedValue({ kind: "writable" });
      }
      const exit = new Error("test lifecycle exit");
      let exitCode: number | undefined;
      vi.mocked(defaultRuntime.exit).mockImplementationOnce((code) => {
        exitCode = code;
        throw exit;
      });
      if (scenario === "native refusal") {
        mocks.restart.mockRejectedValueOnce(new Error("native owner refused"));
      } else if (scenario === "retry refusal") {
        mocks.restart
          .mockImplementationOnce(async () => {
            await servingOwner.restart();
            return { outcome: "completed" };
          })
          .mockRejectedValueOnce(new Error("later native refusal"));
      }
      mocks.health.mockResolvedValue({
        healthy: false,
        staleGatewayPids:
          scenario === "retry refusal" || scenario === "writable retry health" ? [4242] : [],
        runtime: { status: "stopped" },
        portUsage: { port: 19305, status: "free", listeners: [], hints: [] },
      });
      if (progressing) {
        const health = {
          ...readyRecoveryHealth(19305, true),
          healthy: false,
          waitOutcome: "still-starting" as const,
          elapsedMs: 300_000,
          startupPhase: "startup migration",
        };
        mocks.health.mockResolvedValue(
          scenario === "cap then healthy" ? readyRecoveryHealth(19305, true) : health,
        );
        mocks.health.mockResolvedValueOnce(health);
      }
      if (scenario === "unexpected check") {
        mocks.health.mockRejectedValueOnce(new Error("health observer crashed"));
      }
      const actual =
        await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
      mocks.child.mockImplementationOnce(async (argv, options) => {
        const childEnv = typeof options === "number" ? undefined : options.env;
        expect(childEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        await withOwnedManagedUpdateEnv(childEnv, async () => {
          await expect(
            runDaemonRestart({
              json: true,
              preserveDefinition: argv.includes("--preserve-definition"),
            }),
          ).rejects.toBe(exit);
        });
        expect(mocks.restart).toHaveBeenCalled();
        expect(mocks.writeJson).toHaveBeenCalledOnce();
        if (exitCode === undefined) {
          throw new Error("Lifecycle did not return an exit code");
        }
        const serialized = JSON.stringify(mocks.writeJson.mock.lastCall?.[0]);
        await fs.writeFile(
          path.join(root, "dist", "index.js"),
          `process.stdout.write(${JSON.stringify(serialized)}); process.exitCode = ${exitCode};`,
        );
        return actual.runCommandWithTimeout(argv, options);
      });
      const result = serviceUpdateResult(root, progressing ? { after: { version: VERSION } } : {});
      expect(
        await maybeRestartService({
          shouldRestart: true,
          result,
          opts: { json: false, run },
          refreshServiceEnv: false,
          serviceUpdateVerdict: {
            kind: "owned",
            root,
            refreshDefinition: writable,
            fingerprint: "fixture",
          },
          serviceEnv,
          requireRunningServiceAfterRestart: writable,
          gatewayPort: 19305,
          timeoutMs: 1000,
          nodeRunner: process.execPath,
        }),
      ).toBe(expected);
      expect(repair).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.child.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          path.join(root, "dist", "index.js"),
          "gateway",
          "restart",
          "--preserve-definition",
          "--json",
        ]),
      );
      if (progressing) {
        expect(exitCode).toBe(1);
        expect(result.reason).toBe(expected === "readiness-pending" ? "still-starting" : undefined);
        expect(result.recovery).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledOnce();
        expect(mocks.configSnapshot).toHaveBeenCalledTimes(writable ? 1 : 0);
        expect(mocks.terminateStale).not.toHaveBeenCalled();
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "gateway verification", exitCode: 0 }),
        );
        expect(mocks.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            result: "restart-health-failed",
            error: expect.stringContaining("still starting"),
          }),
        );
      }
      if (scenario === "writable retry health") {
        expect(mocks.terminateStale).toHaveBeenCalledExactlyOnceWith(
          [4242],
          expect.objectContaining({ env: expect.any(Object), assertCurrent: expect.any(Function) }),
        );
        expect(mocks.restart).toHaveBeenCalledTimes(2);
        expect(mocks.health.mock.lastCall?.[0]).toMatchObject({
          requireRunningService: true,
          requirePluginHealth: false,
        });
      }
    },
  );

  const healthFailure = {
    action: "restart",
    ok: false,
    result: "restart-health-failed",
    error: "Gateway is unhealthy",
  };
  const json = JSON.stringify(healthFailure);
  const success = JSON.stringify({ action: "restart", ok: true, result: "restarted" });
  it.each<{
    scenario: string;
    response?: Partial<
      Awaited<ReturnType<typeof import("../../process/exec.js").runCommandWithTimeout>>
    >;
    action?: "install" | "restart";
  }>([
    { scenario: "health" },
    { scenario: "missing", response: { stdout: "" } },
    { scenario: "malformed", response: { stdout: "{" } },
    { scenario: "mixed", response: { stdout: `log before result\n${json}` } },
    { scenario: "multiple", response: { stdout: `${json}\n${json}` } },
    {
      scenario: "wrong action",
      response: { stdout: JSON.stringify({ ...healthFailure, action: "install" }) },
    },
    {
      scenario: "wrong result",
      response: { stdout: JSON.stringify({ ...healthFailure, result: "unknown" }) },
    },
    { scenario: "wrong ok", response: { stdout: JSON.stringify({ ...healthFailure, ok: true }) } },
    {
      scenario: "missing error",
      response: { stdout: JSON.stringify({ ...healthFailure, error: undefined }) },
    },
    { scenario: "signal", response: { signal: "SIGTERM", termination: "signal" } },
    { scenario: "timeout", response: { termination: "timeout" } },
    { scenario: "truncated", response: { stdoutTruncatedBytes: 1 } },
    { scenario: "killed", response: { killed: true } },
    { scenario: "wrong exit", response: { code: 2 } },
    { scenario: "forced", response: { cleanup: "forced" } },
    { scenario: "uncertain", response: { cleanup: "uncertain" } },
    { scenario: "forced success", response: { cleanup: "forced", code: 0, stdout: success } },
    { scenario: "uncertain success", response: { cleanup: "uncertain", code: 0, stdout: success } },
    { scenario: "install", action: "install" },
  ])(
    "classifies only the complete owned restart health response ($scenario)",
    async ({ scenario, response, action = "restart" }) => {
      const { root, mocks } = getFixture();
      mocks.child.mockResolvedValueOnce(
        commandResult({
          code: 1,
          stdout: json,
          cleanup: "normal",
          ...response,
        }),
      );
      await expect(
        runUpdatedInstallGatewayCommand(
          {
            result: { root, mode: "npm" },
            opts: {},
            invocationEnv: process.env,
            nodeRunner: process.execPath,
          },
          action,
        ),
      ).rejects.toMatchObject({
        name:
          scenario === "health"
            ? "GatewayRestartHealthError"
            : response?.cleanup === "forced" || response?.cleanup === "uncertain"
              ? "CommandProcessCleanupError"
              : "Error",
      });
      expect(mocks.child.mock.lastCall?.[0]).toContain("--json");
    },
  );
}
