import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as commandRunner from "../../process/exec.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../../version.js";
import type { UpdateCommandOptions } from "./shared.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import {
  readyRecoveryHealth,
  serviceUpdateResult,
} from "./update-command-service-recovery.test-support.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";
import { createShippedUnresolvedServiceStop } from "./update-command-service-state.test-support.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service.js";

export const preservedActivationCases = [
  { phase: "late", mode: "npm", denial: "unknown", outcome: "clean refusal", json: true },
  { phase: "late", mode: "git", denial: "sealed", outcome: "uninspectable", json: false },
  { phase: "late", mode: "npm", denial: "unknown", outcome: "foreign", json: false },
  { phase: "late", mode: "npm", denial: "sealed", outcome: "stale retry", json: false },
  { phase: "late", mode: "git", denial: "sealed", outcome: "missing build", json: false },
] as const;

export type InstallRootTransitionFixture = {
  root: string;
  run: NonNullable<UpdateCommandOptions["run"]>;
  mocks: {
    running: boolean;
    events: string[];
    command: Mock<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>;
    capability: Mock<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >;
    child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
    health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
    configSnapshot: Mock;
  };
};

const stopOptions = { shouldRestart: true, jsonMode: true };
const restartOptions = {
  shouldRestart: true,
  gatewayPort: 19305,
  requireRunningServiceAfterRestart: true,
  timeoutMs: 1000,
};

export function registerInstallRootTransitionTests(getFixture: () => InstallRootTransitionFixture) {
  it.each([
    { scenario: "CLI already uses replacement install", mode: "npm", allowed: true },
    { scenario: "retained source launcher", mode: "npm", allowed: true },
    { scenario: "removed pnpm package root", mode: "pnpm", allowed: true },
    { scenario: "same-version stale launcher after refresh", mode: "npm", allowed: true },
    { scenario: "failed Git refresh retains original launcher", mode: "git", allowed: true },
    { scenario: "Git already serves target build", mode: "git", allowed: true },
    { scenario: "Git still serves previous build", mode: "git", allowed: true },
    { scenario: "changed original launcher", mode: "npm", allowed: false },
    { scenario: "original sealed definition", mode: "npm", allowed: false },
    { scenario: "newly sealed definition", mode: "npm", allowed: false },
    { scenario: "unknown definition authority", mode: "npm", allowed: false },
    { scenario: "retained unresolved launcher", mode: "npm", allowed: false },
    { scenario: "unrequested root transition", mode: "npm", allowed: false },
  ] as const)(
    "refreshes a verified installed root with $scenario",
    async ({ scenario, mode, allowed }) => {
      const { root, run, mocks } = getFixture();
      const replacementCli = scenario === "CLI already uses replacement install";
      const unresolved = scenario === "retained unresolved launcher";
      const stale = scenario === "same-version stale launcher after refresh";
      const failedRefresh = scenario === "failed Git refresh retains original launcher";
      const restartPrevious = scenario === "Git still serves previous build";
      const replacementRoot = path.join(root, "replacement");
      const replacementEntry = path.join(replacementRoot, "dist", "index.js");
      await fs.mkdir(path.dirname(replacementEntry), { recursive: true });
      await fs.writeFile(
        path.join(replacementRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      await fs.writeFile(replacementEntry, "export {};\n");
      mocks.capability.mockResolvedValue(
        scenario === "original sealed definition"
          ? { kind: "sealed", reason: "foreign-owner" }
          : { kind: "writable" },
      );
      if (unresolved) {
        mocks.command.mockResolvedValue({
          programArguments: ["openclaw", "gateway", "run"],
          environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
        });
        mocks.running = false;
      }
      const before = unresolved
        ? createShippedUnresolvedServiceStop(process.env, root)
        : await maybeStopManagedServiceBeforeMutableUpdate({
            updateInstallKind: mode === "npm" && !replacementCli ? "git" : "package",
            root: replacementCli ? replacementRoot : root,
            ...stopOptions,
          });
      expect(before.stopped).toBe(true);
      const command = await mocks.command(process.env);
      if (!command) {
        throw new Error("missing fixture command");
      }
      if (scenario === "removed pnpm package root") {
        await fs.rm(path.join(root, "package.json"));
        await fs.rm(path.join(root, "dist"), { recursive: true });
      } else if (scenario === "changed original launcher") {
        mocks.command.mockResolvedValue({
          ...command,
          programArguments: [...command.programArguments, "--verbose"],
        });
      }
      if (scenario === "newly sealed definition") {
        mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
      } else if (scenario === "unknown definition authority") {
        mocks.capability.mockResolvedValue({ kind: "unknown", reason: "inspection-failed" });
      } else if (scenario === "original sealed definition") {
        mocks.capability.mockResolvedValue({ kind: "writable" });
      }

      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: before.serviceEnv,
        requireEffective: true,
      });
      const pendingVerdict = revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: replacementRoot,
        preManagedServiceStop: before,
        allowInstallRootChange: scenario !== "unrequested root transition",
      });
      if (unresolved) {
        expect(await pendingVerdict).toMatchObject({ kind: "unresolved" });
        expect(mocks.child).not.toHaveBeenCalled();
        return;
      }
      if (!allowed) {
        await expect(pendingVerdict).rejects.toThrow("ownership or manager identity changed");
        expect(mocks.child).not.toHaveBeenCalled();
        return;
      }
      const verdict = await pendingVerdict;
      let servingBuildId = "previous-build";
      if (mode === "git") {
        mocks.health.mockImplementation(async ({ port, expectedBuildId }) => {
          const healthy = mocks.running && (!expectedBuildId || expectedBuildId === servingBuildId);
          return {
            ...readyRecoveryHealth(port, mocks.running),
            outcome: healthy ? "ready" : "failed",
            healthy,
          };
        });
      }
      mocks.child.mockImplementation(async (argv) => {
        expect(argv).toContain(replacementEntry);
        if (argv.includes("install")) {
          if (replacementCli) {
            expect(argv.slice(argv.indexOf("--port"), argv.indexOf("--port") + 2)).toEqual([
              "--port",
              "19305",
            ]);
          }
          mocks.events.push("install verified replacement");
          if (failedRefresh) {
            return commandResult({
              code: 1,
              stderr: "service install failed before writing the definition",
            });
          }
          if (!stale) {
            mocks.command.mockResolvedValue({
              ...command,
              programArguments: [process.execPath, replacementEntry, "gateway", "--port", "19305"],
            });
          }
          if (scenario === "Git already serves target build") {
            servingBuildId = "target-build";
          }
        } else {
          expect(argv).toContain("restart");
          expect(argv).toContain("--preserve-definition");
          mocks.events.push("restart managed service");
          servingBuildId = "target-build";
        }
        mocks.running = true;
        return commandResult();
      });
      if (restartPrevious) {
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
      }
      const result = serviceUpdateResult(replacementRoot, {
        mode,
        before: { version: VERSION },
        after: { version: VERSION, ...(mode === "git" ? { buildId: "target-build" } : {}) },
      });
      const activated = await maybeRestartService({
        ...restartOptions,
        result,
        opts: { json: true, run },
        refreshServiceEnv: true,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
      });
      expect(activated).toBe(stale || failedRefresh ? "reconciliation-pending" : "ok");
      expect(mocks.configSnapshot).toHaveBeenCalledTimes(restartPrevious ? 1 : 0);
      expect(mocks.events).toEqual([
        "native stop",
        "install verified replacement",
        ...(restartPrevious ? ["restart managed service"] : []),
      ]);
      if (scenario === "Git already serves target build" || restartPrevious) {
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ expectedBuildId: "target-build", requireRunningService: true }),
        );
      }
      expect(mocks.child.mock.calls.filter(([argv]) => argv.includes("install"))).toHaveLength(1);
      if (stale || failedRefresh) {
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            advisory: expect.objectContaining({
              message: expect.stringContaining("gateway install --force"),
            }),
          }),
        );
      }
    },
  );
}

type PluginMaintenanceFixture = InstallRootTransitionFixture & {
  writeConfig: (version: string) => Promise<void>;
  mocks: {
    log: Mock;
    start: Mock;
    restart: Mock;
    doctor: Mock;
    call: Mock<typeof import("../../gateway/call.js").callGateway>;
  };
};

export function registerPluginMaintenanceTests(getFixture: () => PluginMaintenanceFixture) {
  it.each(["git", "npm"] as const)(
    "delegates %s activation and post-handoff Doctor after newer config is stamped",
    async (mode) => {
      const { root, run, mocks, writeConfig } = getFixture();
      const entry = path.join(root, "dist", "index.js");
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: mode === "git" ? "git" : "package",
        root,
        ...stopOptions,
      });
      expect(before.stopped).toBe(true);
      mocks.events.push("core updated");
      await writeConfig("9999.1.1");
      mocks.call.mockImplementation(
        gatewayHealthResponse({ server: { version: "9999.1.1", bootId: "service-boot" } }),
      );
      mocks.events.push("candidate doctor stamped config");
      const service = resolveGatewayService();
      const state = await readGatewayServiceState(service, { requireEffective: true });
      const verdict = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root,
        preManagedServiceStop: before,
      });

      const activated = await maybeRestartService({
        ...restartOptions,
        result: serviceUpdateResult(root, {
          mode,
          before: { version: VERSION },
          after: { version: "9999.1.1" },
        }),
        opts: { run },
        refreshServiceEnv: false,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
      });

      expect(activated, mocks.log.mock.calls.flat().join("\n")).toBe("ok");
      expect(mocks.events).toEqual([
        "native stop",
        "core updated",
        "candidate doctor stamped config",
        "fresh CLI restart",
      ]);
      const child = mocks.child.mock.calls[0];
      expect(child?.[0].slice(1)).toEqual([
        entry,
        "gateway",
        "restart",
        "--preserve-definition",
        "--json",
      ]);
      expect(mocks.health.mock.calls[0]?.[0]).toMatchObject({
        port: 19305,
        expectedVersion: "9999.1.1",
        requireRunningService: true,
      });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.doctor).not.toHaveBeenCalled();
      // The old adapter still refuses the same config: delegation must not weaken its guard.
      await expect(service.restart({ env: state.env, stdout: process.stdout })).rejects.toThrow(
        "older than the config",
      );

      process.env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
      const doctorRunner = vi.spyOn(commandRunner, "runUtf8CommandWithTimeout");
      await runUpdateFinalizationDoctorInFreshProcess({
        root,
        phase: "post-plugin",
        yes: true,
        json: true,
        timeoutMs: 1000,
      });
      const repairFlags = ["--repair", "--non-interactive", "--no-workspace-suggestions", "--yes"];
      expect(doctorRunner.mock.calls.filter(([argv]) => argv[2] === "doctor")).toEqual([
        [
          [process.execPath, entry, "doctor", ...repairFlags],
          expect.objectContaining({ cwd: root }),
        ],
      ]);
      // Delegation must leave the stale parent's destructive-action guard intact.
      await expect(service.stop({ env: state.env, stdout: process.stdout })).rejects.toThrow(
        "older than the config",
      );
    },
  );
}
