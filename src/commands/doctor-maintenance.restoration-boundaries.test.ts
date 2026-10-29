import "./doctor-maintenance.settlement.test-support.js";
import { expect, it, vi } from "vitest";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { resolveGatewayService } from "../daemon/service.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
const settlement = await import("./doctor-maintenance.settlement.test-support.js");
const { begin, boundary, root } = settlement;

it.each([false, true])(
  "settles interrupted original-state capture (restart fails: %s)",
  async (restartFails) => {
    let drain: Promise<unknown> | undefined;
    const runtimeError = vi.fn();
    if (restartFails) {
      boundary.restart.mockRejectedValueOnce(new Error("synthetic service start failure"));
    }
    const admission = beginDoctorMaintenance({
      root,
      options: { repair: true, nonInteractive: true },
      runtime: { log: boundary.log, error: runtimeError, exit: vi.fn() },
      beforeStateMutation: async ({ signal }) => {
        drain = waitForSignalExitBarriers("SIGINT").catch((error: unknown) => error);
        signal.throwIfAborted();
      },
    });
    await expect(admission).rejects.toThrow(
      restartFails ? "synthetic service start failure" : "Doctor interrupted by SIGINT",
    );
    await drain;
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledTimes(restartFails ? 0 : 1);
    if (restartFails) {
      expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway start"));
    }
  },
);

it.each([
  "owned-offline",
  "running-indicator",
  "unknown-runtime",
  "unknown-load",
  "read-failed",
  "not-ours",
])("rechecks an initially stopped Gateway after config repair: %s", async (outcome) => {
  boundary.stop.mockImplementation(async () => ({ ...settlement.stopped, stopped: false }));
  const state = {
    ...(await boundary.read(resolveGatewayService())),
    loadState: { status: "not-loaded" as const },
  };
  boundary.read.mockResolvedValue(state);
  boundary.repair.mockImplementation(async () => {
    if (outcome === "read-failed") {
      boundary.read.mockRejectedValue(new Error("Synthetic final inspection failed"));
    } else {
      boundary.read.mockResolvedValue({
        ...state,
        running: outcome === "running-indicator",
        loadState:
          outcome === "unknown-load"
            ? { status: "unknown", detail: "probe failed" }
            : state.loadState,
        runtime: {
          status: outcome === "unknown-runtime" ? "unknown" : "stopped",
        },
      });
      if (outcome === "not-ours") {
        boundary.revalidate.mockResolvedValue({ kind: "foreign" });
      }
    }
    return {};
  });
  const maintenance = await begin();
  await expect(maintenance!.finish({}, async (cfg) => cfg)).resolves.toBeUndefined();
  expect(boundary.repair).toHaveBeenCalledOnce();
  expect(boundary.restart).toHaveBeenCalledTimes(outcome === "owned-offline" ? 1 : 0);
  const verified = outcome === "owned-offline";
  expect(boundary.health).toHaveBeenCalledTimes(verified ? 1 : 0);
  if (!verified) {
    expect(maintenance!.warnings).toContainEqual(
      expect.stringMatching(/Gateway activation skipped.*gateway status --deep/),
    );
  }
});
