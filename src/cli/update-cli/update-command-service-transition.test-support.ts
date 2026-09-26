import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { runExec } from "../../process/exec.js";
import { VERSION } from "../../version.js";
import type { UpdateCommandOptions } from "./shared.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import { createShippedUnresolvedServiceStop } from "./update-command-service-state.test-support.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service.js";

export const preservedActivationCases = [
  { phase: "initial", mode: "git", denial: "sealed", outcome: "healthy", json: true },
  { phase: "initial", mode: "npm", denial: "sealed", outcome: "healthy", json: true },
  { phase: "initial", mode: "npm", denial: "sealed", outcome: "stale retry", json: true },
  { phase: "late", mode: "git", denial: "sealed", outcome: "healthy", json: false },
  { phase: "late", mode: "npm", denial: "unknown", outcome: "healthy", json: false },
  { phase: "late", mode: "git", denial: "unknown", outcome: "json denial", json: true },
  { phase: "late", mode: "npm", denial: "sealed", outcome: "json denial", json: true },
  { phase: "late", mode: "git", denial: "sealed", outcome: "uninspectable", json: false },
  { phase: "late", mode: "npm", denial: "unknown", outcome: "foreign", json: false },
  { phase: "late", mode: "git", denial: "unknown", outcome: "stale retry", json: false },
  { phase: "late", mode: "npm", denial: "sealed", outcome: "stale retry", json: false },
  { phase: "initial", mode: "git", denial: "unknown", outcome: "stale build", json: false },
  { phase: "initial", mode: "git", denial: "sealed", outcome: "missing build", json: false },
  { phase: "late", mode: "git", denial: "unknown", outcome: "stale build", json: false },
  { phase: "late", mode: "git", denial: "sealed", outcome: "missing build", json: false },
  { phase: "late", mode: "pnpm", denial: "sealed", outcome: "healthy", json: false },
  { phase: "late", mode: "bun", denial: "unknown", outcome: "healthy", json: false },
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
      if (scenario === "retained unresolved launcher") {
        mocks.command.mockResolvedValue({
          programArguments: ["openclaw", "gateway", "run"],
          environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
        });
        mocks.running = false;
      }
      const before =
        scenario === "retained unresolved launcher"
          ? createShippedUnresolvedServiceStop(process.env, root)
          : await maybeStopManagedServiceBeforeMutableUpdate({
              updateInstallKind:
                mode === "npm" && scenario !== "CLI already uses replacement install"
                  ? "git"
                  : "package",
              root: scenario === "CLI already uses replacement install" ? replacementRoot : root,
              shouldRestart: true,
              jsonMode: true,
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
      if (scenario === "retained unresolved launcher") {
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
        mocks.health.mockImplementation(async ({ port, expectedBuildId }) => ({
          healthy: mocks.running && (!expectedBuildId || expectedBuildId === servingBuildId),
          staleGatewayPids: [],
          runtime: {
            status: mocks.running ? "running" : "stopped",
            pid: mocks.running ? 4242 : undefined,
          },
          gatewayBootId: "service-boot",
          portUsage: { port, status: "busy", listeners: [], hints: [] },
        }));
      }
      mocks.child.mockImplementation(async (argv) => {
        expect(argv).toContain(replacementEntry);
        if (argv.includes("install")) {
          if (scenario === "CLI already uses replacement install") {
            expect(argv.slice(argv.indexOf("--port"), argv.indexOf("--port") + 2)).toEqual([
              "--port",
              "19305",
            ]);
          }
          mocks.events.push("install verified replacement");
          if (scenario === "failed Git refresh retains original launcher") {
            return {
              code: 1,
              stdout: "",
              stderr: "service install failed before writing the definition",
              signal: null,
              killed: false,
              termination: "exit",
            };
          }
          if (scenario !== "same-version stale launcher after refresh") {
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
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      if (scenario === "Git still serves previous build") {
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
      }
      const result: Parameters<typeof maybeRestartService>[0]["result"] = {
        status: "ok",
        mode,
        root: replacementRoot,
        before: { version: VERSION },
        after: { version: VERSION, ...(mode === "git" ? { buildId: "target-build" } : {}) },
        steps: [],
        durationMs: 0,
      };
      const activated = await maybeRestartService({
        shouldRestart: true,
        result,
        opts: { json: true, run },
        refreshServiceEnv: true,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
      });
      expect(activated).toBe(
        scenario !== "same-version stale launcher after refresh" &&
          scenario !== "failed Git refresh retains original launcher"
          ? "ok"
          : "reconciliation-pending",
      );
      expect(mocks.configSnapshot).toHaveBeenCalledTimes(
        scenario === "Git still serves previous build" ? 1 : 0,
      );
      expect(mocks.events).toEqual([
        "native stop",
        "install verified replacement",
        ...(scenario === "Git still serves previous build" ? ["restart managed service"] : []),
      ]);
      if (
        scenario === "Git already serves target build" ||
        scenario === "Git still serves previous build"
      ) {
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ expectedBuildId: "target-build", requireRunningService: true }),
        );
      }
      expect(mocks.child.mock.calls.filter(([argv]) => argv.includes("install"))).toHaveLength(1);
      if (
        scenario === "same-version stale launcher after refresh" ||
        scenario === "failed Git refresh retains original launcher"
      ) {
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
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: mode === "git" ? "git" : "package",
        root,
        shouldRestart: true,
        jsonMode: true,
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
        shouldRestart: true,
        result: {
          status: "ok",
          mode,
          root,
          steps: [],
          durationMs: 0,
          before: { version: VERSION },
          after: { version: "9999.1.1" },
        },
        opts: { run },
        refreshServiceEnv: false,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
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
        path.join(root, "dist", "index.js"),
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
      vi.mocked(runExec).mockResolvedValueOnce({ stdout: "", stderr: "" });
      await runUpdateFinalizationDoctorInFreshProcess({
        root,
        phase: "post-plugin",
        yes: true,
        json: true,
        timeoutMs: 1000,
      });
      expect(runExec).toHaveBeenLastCalledWith(
        process.execPath,
        [
          path.join(root, "dist", "index.js"),
          "doctor",
          "--repair",
          "--non-interactive",
          "--no-workspace-suggestions",
          "--yes",
        ],
        expect.objectContaining({ cwd: root }),
      );
      // Delegation must leave the stale parent's destructive-action guard intact.
      await expect(service.stop({ env: state.env, stdout: process.stdout })).rejects.toThrow(
        "older than the config",
      );
    },
  );
}
