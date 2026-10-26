import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { expect, it, vi, type Mock } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
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
import type { InstallRootTransitionFixture } from "./update-command-service-fixtures.test-support.js";
import { maintenanceDefaults } from "./update-command-service-fixtures.test-support.js";
import {
  type createServiceActivationFixture,
  readyRecoveryHealth,
  serviceUpdateResult,
} from "./update-command-service-recovery.test-support.js";
import {
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service.js";

function revocableAuthority() {
  let current = true;
  return {
    assertCurrent() {
      if (!current) {
        throw new Error("Original update owner revoked");
      }
    },
    revoke() {
      current = false;
    },
  };
}
const installed = () => commandResult({ stdout: JSON.stringify({ action: "install", ok: true }) });
const verifiedStep = expect.objectContaining({ name: "gateway verification", exitCode: 0 });

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
  async function prepareRestart(
    root: string,
    result: UpdateRunResult,
    before: Awaited<ReturnType<typeof maybeStopManagedServiceBeforeMutableUpdate>>,
    run: NonNullable<UpdateCommandOptions["run"]>,
  ) {
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
    return {
      ...prepared,
      shouldRestart: true,
      result,
      opts: { json: true, run },
      refreshServiceEnv: prepared.refreshGatewayServiceEnv,
      serviceEnv: prepared.gatewayServiceEnv,
      serviceInstallEnv: prepared.gatewayServiceInstallEnv,
      timeoutMs: 1_000,
    };
  }
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
        ...maintenanceDefaults,
        root,
      });
      const result: UpdateRunResult = serviceUpdateResult(root);
      const prepared = await prepareRestart(root, result, before, run);
      const executorFence = revocableAuthority();
      mocks.configSnapshot.mockImplementationOnce(async () => {
        if (revoked) {
          executorFence.revoke();
        }
      });
      mocks.child.mockImplementation(async (argv) => {
        if (argv.includes("restart")) {
          const program = new Command().exitOverride();
          addGatewayServiceCommands(program.command("gateway"));
          await program.parseAsync(argv.slice(2), { from: "user" });
        } else {
          expect(argv).toContain("install");
        }
        return argv.includes("restart")
          ? commandResult({ stdout: JSON.stringify(mocks.writeJson.mock.lastCall?.[0]) })
          : installed();
      });
      const onVerified = vi.fn();
      const activation = maybeRestartService({
        ...prepared,
        opts: { json: true, run: { ...run, executorFence } },
        onVerified,
      });
      if (revoked) {
        await expect(activation).rejects.toThrow("Original update owner revoked");
        expect(mocks.restart).not.toHaveBeenCalled();
        expect(onVerified).not.toHaveBeenCalled();
        // The completed install child keeps its timing; nothing after revocation is recorded.
        expect(result.steps.map(({ name }) => name)).toEqual(["managed-service-install"]);
      } else {
        await expect(activation).resolves.toBe("ok");
        expect(onVerified).toHaveBeenCalledOnce();
        expect(result.steps).toContainEqual(verifiedStep);
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
        ...maintenanceDefaults,
        updateInstallKind: switchingInstall ? "git" : "package",
        root,
      });
      let command = await mocks.command(process.env);
      if (!command) {
        throw new Error("Missing managed service fixture command");
      }
      expect(before.stopped).toBe(true);
      const authority = revocableAuthority();
      run.executorFence = authority;
      mocks.command.mockImplementation(async (_env, options) => {
        if (options?.requireLoaded && !mocks.running) {
          if (!options.loadForInspection) {
            throw new Error("Effective systemd service command could not be inspected.");
          }
          expect(options.loadForInspection.managerUid).toBe(before.serviceManagerUid);
          if (scenario === "revoked recovery") {
            authority.revoke();
          }
          options.loadForInspection.assertCurrent();
        }
        return command;
      });
      if (switchingInstall) {
        const packageRoot = path.join(root, "npm", "lib", "node_modules", "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, VERSION);
        // Model the persisted output of candidate Doctor before service revalidation.
        const configPath = path.join(root, ".openclaw", "openclaw.json");
        const config = JSON.parse(await fs.readFile(configPath, "utf8"));
        config.update = { channel: "stable" };
        await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
        const beforeInstall = command;
        mocks.child.mockImplementation(async (argv) => {
          expect(argv).toEqual(expect.arrayContaining([packageEntry, "install", "--force"]));
          expect(command).toBe(beforeInstall);
          command = {
            ...beforeInstall,
            programArguments: [process.execPath, packageEntry, "gateway", "--port", "19305"],
          };
          mocks.running = true;
          return installed();
        });
        const result = serviceUpdateResult(packageRoot, {
          before: { version: VERSION },
          after: { version: VERSION },
        });
        const prepared = await prepareRestart(root, result, before, run);
        await expect(maybeRestartService(prepared)).resolves.toBe("ok");
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
    ["native refusal", "failed"],
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
      }
      mocks.health.mockResolvedValue({
        outcome: "failed",
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: "stopped" },
        portUsage: { port: 19305, status: "free", listeners: [], hints: [] },
      });
      if (progressing) {
        const health = {
          ...readyRecoveryHealth(19305, true),
          outcome: "starting" as const,
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
      if (progressing) {
        expect(exitCode).toBe(1);
        expect(result.reason).toBe(expected === "readiness-pending" ? "still-starting" : undefined);
        expect(result.recovery).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledOnce();
        expect(mocks.terminateStale).not.toHaveBeenCalled();
        expect(result.steps).toContainEqual(verifiedStep);
        expect(mocks.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            result: "restart-health-failed",
            error: expect.stringContaining("still starting"),
          }),
        );
      }
    },
  );

  const json = JSON.stringify({
    action: "restart",
    ok: false,
    result: "restart-health-failed",
    error: "Gateway is unhealthy",
  });
  it.each([
    ["missing", { stdout: "" }, "Error"],
    ["truncated", { stdoutTruncatedBytes: 1 }, "Error"],
    ["uncertain", { cleanup: "uncertain" }, "CommandProcessCleanupError"],
  ] as const)(
    "classifies only the complete owned restart health response (%s)",
    async (_scenario, response, name) => {
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
          "restart",
        ),
      ).rejects.toMatchObject({ name });
      expect(mocks.child.mock.lastCall?.[0]).toContain("--json");
    },
  );
}
