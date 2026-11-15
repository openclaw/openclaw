import fs from "node:fs/promises";
import { expect, it, vi, type Mock } from "vitest";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import * as configPaths from "../../config/paths.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { updateRunWarningMessages } from "../../infra/update-run-step.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import type { GatewayRestartResult } from "../daemon-cli/restart-health.types.js";
import { registerUpdateCli } from "../update-cli.js";
import type { LeaseScenario } from "./update-command-lease.test-support.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import * as serviceMaintenance from "./update-command-service-maintenance.js";

export function seedInterruptedPostCoreRun(): UpdateRunRecord {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * ABANDONED_UPDATE_RUN_MS);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    return recordUpdateRunPhase(run.runId, "verifying", {
      step: { step: "post-update verification", status: "in_progress" },
    });
  } finally {
    clock.mockRestore();
  }
}

/** Parent and fresh Doctor observe the same fixture-owned service, never a live Gateway. */
async function mockRepairManagedService(
  state: OpenClawTestState,
  entrypoint: string,
  restartFails: boolean,
) {
  const serviceState = state.statePath("managed-service-state");
  await fs.writeFile(serviceState, "running");
  vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
  vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
  const verdict = {
    kind: "owned" as const,
    root: state.root,
    fingerprint: "repair-service",
    refreshDefinition: false,
  };
  const stop = vi
    .spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate")
    .mockImplementation(async ({ phase }) => {
      if (phase !== "inspect") {
        await fs.writeFile(serviceState, "stopped");
      }
      return {
        stopped: phase !== "inspect",
        inspected: true,
        runtimeInspected: true,
        running: phase === "inspect",
        offline: phase !== "inspect",
        serviceEnv: { ...process.env },
        serviceUpdateVerdict: verdict,
      };
    });
  vi.spyOn(serviceMaintenance, "revalidateManagedGatewayServiceAfterUpdate").mockResolvedValue(
    verdict,
  );
  const restart = vi.fn(async () => {
    if (restartFails) {
      throw new Error("fixture service manager restart failed");
    }
    await fs.writeFile(serviceState, "running");
    return { outcome: "completed" as const };
  });
  const readRuntime: gatewayService.GatewayService["readRuntime"] = async () =>
    (await fs.readFile(serviceState, "utf8")) === "running"
      ? { status: "running", pid: process.pid + 1 }
      : { status: "stopped" };
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
    createMockGatewayService({
      isLoaded: async () => true,
      readCommand: async () => ({
        programArguments: [process.execPath, entrypoint, "gateway", "--port", "19003"],
        environment: {
          OPENCLAW_STATE_DIR: state.stateDir,
          OPENCLAW_CONFIG_PATH: state.configPath,
        },
      }),
      readRuntime,
      restart,
    }),
  );
  const readHealth = async (): Promise<GatewayRestartResult> => {
    const runtime = await readRuntime(process.env);
    const running = runtime.status === "running";
    return {
      outcome: running ? "ready" : "failed",
      healthy: running,
      waitOutcome: running ? "healthy" : "stopped-free",
      staleGatewayPids: [],
      runtime,
      gatewayVersion: running ? "1.0.0" : undefined,
      gatewayBootId: running ? "repair-service" : undefined,
      portUsage: { port: 19003, status: running ? "busy" : "free", listeners: [], hints: [] },
    };
  };
  vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockImplementation(readHealth);
  vi.spyOn(restartHealth, "inspectGatewayRestart").mockImplementation(readHealth);
  vi.spyOn(restartHealth, "waitForGatewayHttpReadiness").mockImplementation(async () => {
    const running = (await readRuntime(process.env)).status === "running";
    return { healthz: running ? 200 : null, readyz: running ? 200 : null };
  });
  return { serviceState, stop, restart };
}

export function registerLeaseServiceRestorationTests(params: {
  context: () => { state: OpenClawTestState; entrypoint: string };
  writeScenario: (scenario: Omit<LeaseScenario, "lane">) => Promise<void>;
  expectSuccess: () => void;
  expectRecoveredRun: (run: UpdateRunRecord | undefined) => void;
}) {
  it.each([
    { command: "finalize", failDoctor: undefined, restartFails: false },
    { command: "repair", failDoctor: undefined, restartFails: false },
    { command: "repair", failDoctor: "pre", restartFails: false },
    { command: "repair", failDoctor: undefined, restartFails: true },
  ] as const)(
    "the $command parent restores its managed service (Doctor failure=$failDoctor, restart failure=$restartFails)",
    async ({ command, failDoctor, restartFails }) => {
      const { state, entrypoint } = params.context();
      const recovery = seedInterruptedPostCoreRun();
      await params.writeScenario({
        verifyRepairOwner: command === "repair",
        verifyServiceCustody: true,
        failDoctor,
      });
      const { serviceState, stop, restart } = await mockRepairManagedService(
        state,
        entrypoint,
        restartFails,
      );

      await runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", command, "--yes", "--json", "--timeout", "15"],
      });

      expect(stop.mock.calls.filter(([{ phase }]) => phase !== "inspect")).toHaveLength(1);
      expect(restart).toHaveBeenCalledOnce();
      expect(await fs.readFile(serviceState, "utf8")).toBe(restartFails ? "stopped" : "running");
      if (restartFails || failDoctor) {
        expect(listUpdateRuns()[0]).toMatchObject({
          status: "failed",
          reason: restartFails ? "doctor-gateway-restoration-failed" : "doctor-failed",
          verification: {
            serviceRunning: !restartFails,
            readyz: !restartFails,
            ...(!restartFails && { recovery: { service: "healthy" } }),
          },
        });
      } else {
        params.expectSuccess();
      }
      if (restartFails) {
        const diagnostics = vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n");
        expect(diagnostics).toContain("managed Gateway could not be restored");
        expect(diagnostics).toContain("openclaw gateway restart");
      }
      const recoveredRun = getUpdateRun(recovery.runId);
      if (command === "repair" && !restartFails && !failDoctor) {
        params.expectRecoveredRun(recoveredRun);
      } else {
        expect(recoveredRun).toEqual(recovery);
      }
    },
  );
}

export function registerLegacyResumeWarningTests(params: {
  context: () => { state: OpenClawTestState; entrypoint: string };
  writeScenario: (scenario: Omit<LeaseScenario, "lane">) => Promise<void>;
  invoke: () => Promise<void>;
  plugins: Mock<typeof import("./update-command-plugins.js").updatePluginsAfterCoreUpdate>;
  pluginResult: PostCorePluginUpdateResult;
  events: () => Promise<string[]>;
  expectDoctorDiagnostics: () => void;
}) {
  it.each(["unchanged", "changed", "failed"] as const)(
    "legacy resume settles Doctor warnings before %s plugin convergence",
    async (outcome) => {
      const changed = outcome === "changed";
      const failed = outcome === "failed";
      const warnings = ["First Doctor repair deferred.", "Second Doctor repair deferred."];
      const doctorWarnings = changed || failed ? warnings : warnings.slice(0, 1);
      const { state, entrypoint } = params.context();
      await params.writeScenario({ doctorWarnings: failed ? warnings : warnings.slice(0, 1) });
      await fs.rm(state.path("handoff.json"));
      const { runId } = adoptUpdateRun(createUpdateRun({ trigger: "cli" }).runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", runId);
      const resultPath = state.path("post-core-result.json");
      if (failed) {
        params.plugins.mockRejectedValueOnce(new Error("plugin fixture failure"));
        await expect(params.invoke()).rejects.toThrow("plugin fixture failure");
      } else {
        params.plugins.mockImplementationOnce(async () => {
          expect(await params.events()).toEqual(["post-attempt", "post-acquired"]);
          expect(await fs.stat(resultPath).catch(() => null)).toBeNull();
          if (changed) {
            await state.writeJson("scenario.json", {
              lane: "resume",
              doctorWarnings: warnings.slice(1),
            } satisfies LeaseScenario);
          }
          return { ...params.pluginResult, changed };
        });
        await params.invoke();
      }
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      const recorded = getUpdateRun(runId);
      expect(updateRunWarningMessages(recorded?.steps ?? [])).toEqual(doctorWarnings);
      if (failed) {
        expect(result).toMatchObject({
          status: "failed",
          error: expect.stringContaining("plugin fixture failure"),
        });
        expect(result.error).not.toContain(state.root);
        expect(recorded).toMatchObject({ status: "running", after: {} });
        expect(recorded?.steps.map((step) => step.step)).not.toContain(
          "finalize:installed-candidate",
        );
        const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
        expect(probe.stdout).toBe("acquired");
      } else {
        expect(result).toMatchObject({
          status: "warning",
          changed,
          warnings: doctorWarnings.map((message) => ({ reason: "doctor-advisory", message })),
        });
        expect(await params.events()).toEqual([
          "post-attempt",
          "post-acquired",
          ...(changed ? ["post-attempt", "post-acquired"] : []),
          "validate",
          "readiness",
        ]);
        params.expectDoctorDiagnostics();
      }
    },
  );
}
