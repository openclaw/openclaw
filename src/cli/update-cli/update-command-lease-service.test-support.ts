import fs from "node:fs/promises";
import { vi } from "vitest";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import * as configPaths from "../../config/paths.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
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

/** Native manager fixture shared with the fresh Doctor's observed service state. */
export async function mockRepairManagedService(
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
  // Restoration and failure observation read the same fixture-owned service;
  // no real Gateway listens on the fixture port.
  const readHealth = async (): Promise<restartHealth.GatewayRestartSnapshot> => {
    const runtime = await readRuntime(process.env);
    const running = runtime.status === "running";
    return {
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
