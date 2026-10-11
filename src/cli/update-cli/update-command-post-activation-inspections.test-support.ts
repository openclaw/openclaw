import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { expect, it, vi, type Mock } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerMaintenanceCommands } from "../program/register.maintenance.js";
import {
  finishSuccessfulPackageSwitch,
  successfulPluginUpdate,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";

export function registerPostActivationInspectionTests({
  tempDirs,
  mocks,
}: {
  tempDirs: Pick<ReturnType<typeof useAutoCleanupTempDirTracker>, "make">;
  mocks: {
    updatePlugins: Mock;
    completePluginUpdate: Mock;
    printResult: Mock;
    stopService: Mock<
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
  };
}) {
  it.each([
    { owner: "original updater", candidateRuntime: false, marker: false, runs: true, ready: true },
    {
      owner: "migrated worker with the marker",
      candidateRuntime: true,
      marker: true,
      runs: true,
      ready: true,
    },
    {
      owner: "worker from a shipped updater",
      candidateRuntime: true,
      marker: false,
      runs: false,
      ready: true,
    },
    {
      owner: "unverified Gateway",
      candidateRuntime: false,
      marker: false,
      runs: true,
      ready: false,
    },
    {
      owner: "plugin-only update",
      candidateRuntime: false,
      marker: false,
      runs: true,
      ready: true,
      coreAlreadyCurrent: true,
    },
    {
      owner: "plugin-only update with a stopped service",
      candidateRuntime: false,
      marker: false,
      runs: false,
      ready: false,
      coreAlreadyCurrent: true,
      serviceRunning: false,
    },
  ])(
    "runs deferred Doctor inspections after the restart for the $owner",
    async ({
      candidateRuntime,
      marker,
      runs,
      ready,
      coreAlreadyCurrent = false,
      serviceRunning = true,
    }) => {
      const root = tempDirs.make("post-activation-inspections-");
      const lintLog = path.join(root, "lint.json");
      const findings = [
        ...(!candidateRuntime
          ? [
              {
                checkId: "core/doctor/runtime-tool-schemas",
                severity: "warning",
                message: "Plugin drift.",
              },
            ]
          : []),
        {
          checkId: "core/doctor/command-owner",
          severity: "info",
          message: "No command owner is configured.",
        },
      ];
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(
        path.join(root, "dist", "index.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(lintLog)}, JSON.stringify({ argv: process.argv.slice(2), inProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS ?? null }));
process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, checksRun: 3, findings }))});
process.exitCode = 1;
`,
      );
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      if (marker) {
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS", "1");
      }
      const plugins = { ...successfulPluginUpdate, changed: coreAlreadyCurrent };
      mocks.updatePlugins.mockResolvedValue(plugins);
      mocks.stopService.mockImplementation(async ({ expectedService }) => ({
        ...expectedService,
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: serviceRunning,
      }));
      mocks.completePluginUpdate.mockImplementation(async ({ beforeDoctor }) => {
        await beforeDoctor?.();
        expect(process.env.OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS).toBe(
          runs ? "1" : "0",
        );
        return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
      });
      const events: string[] = [];
      mocks.restartService.mockImplementation(async ({ onVerified }) => {
        events.push(
          await fs.stat(lintLog).then(
            () => "restart after lint",
            () => "restart",
          ),
        );
        if (ready) {
          onVerified?.(Date.now());
        }
        return "ok";
      });
      const doctorStep = {
        name: "openclaw doctor",
        command: "openclaw doctor --fix",
        cwd: root,
        durationMs: 1,
        exitCode: 0,
      };
      const initialSteps = coreAlreadyCurrent ? [] : [doctorStep];

      await finishSuccessfulPackageSwitch(
        {
          packageRoot: root,
          restartEnvironment: process.env,
          sealed: coreAlreadyCurrent,
          stoppedForUpdate: !coreAlreadyCurrent,
        },
        {
          coreAlreadyCurrent,
          ...(coreAlreadyCurrent
            ? {
                preManagedServiceStop: {
                  stopped: false,
                  inspected: true,
                  runtimeInspected: true,
                  running: serviceRunning,
                  serviceMutationAllowed: true,
                  serviceUpdateVerdict: {
                    kind: "owned" as const,
                    root,
                    refreshDefinition: false,
                    fingerprint: "sealed",
                  },
                },
              }
            : {}),
          result: { status: "ok", mode: "npm", root, steps: initialSteps, durationMs: 1 },
          packageUpdateNodeRunner: process.execPath,
        },
        { candidateRuntime },
      );

      expect(events).toEqual(coreAlreadyCurrent && !serviceRunning ? [] : ["restart"]);
      const steps = mocks.printResult.mock.lastCall?.[0].steps;
      if (!runs) {
        await expect(fs.stat(lintLog)).rejects.toThrow();
        expect(steps).toEqual(initialSteps);
        return;
      }
      if (!ready) {
        await expect(fs.stat(lintLog)).rejects.toThrow();
        expect(steps).toEqual([
          ...initialSteps,
          expect.objectContaining({
            name: "post-activation doctor inspections",
            advisory: expect.objectContaining({
              kind: "recoverable-maintenance",
              message: expect.stringContaining("Gateway readiness was not verified"),
            }),
          }),
        ]);
        expect(mocks.printResult.mock.lastCall?.[0].status).toBe("ok");
        return;
      }
      const lint = JSON.parse(await fs.readFile(lintLog, "utf8"));
      const program = new Command();
      registerMaintenanceCommands(program);
      const doctor = program.commands.find((command) => command.name() === "doctor");
      assert(doctor);
      doctor.parseOptions(lint.argv.slice(1));
      const options = doctor.opts();
      expect(options.severityMin).toBe("info");
      expect(options.only).toHaveLength(12);
      expect(options.only).toEqual(
        expect.arrayContaining([
          "core/doctor/hooks-model",
          "core/doctor/runtime-tool-schemas",
          "core/doctor/provider-catalog-projection",
        ]),
      );
      expect(options.only).not.toContain("core/doctor/security");
      expect(options.only).not.toContain("core/doctor/session-snapshots");
      expect(options.only).not.toContain("core/doctor/workspace-status");
      expect(lint.inProgress).toBeNull();
      expect(steps).toEqual([
        ...initialSteps,
        expect.objectContaining({
          name: "post-activation doctor inspections",
          exitCode: 1,
          ...(!candidateRuntime
            ? { warnings: ["core/doctor/runtime-tool-schemas: Plugin drift."] }
            : {}),
          doctorLintFindings: findings,
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        }),
      ]);
      expect(mocks.printResult.mock.lastCall?.[0].status).toBe("ok");
    },
  );
}
