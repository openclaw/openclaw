import "./doctor-maintenance.settlement.test-support.js";
import { expect, it } from "vitest";
import { resolveGatewayService } from "../daemon/service.js";

const settlement = await import("./doctor-maintenance.settlement.test-support.js");
const { begin, boundary } = settlement;

it.each([
  "owned-offline",
  "running",
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
        running: outcome === "running" || outcome === "running-indicator",
        loadState:
          outcome === "unknown-load"
            ? { status: "unknown", detail: "probe failed" }
            : state.loadState,
        runtime: {
          status:
            outcome === "unknown-runtime"
              ? "unknown"
              : outcome === "running"
                ? "running"
                : "stopped",
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
  const verified = outcome === "owned-offline" || outcome === "running";
  expect(boundary.health).toHaveBeenCalledTimes(verified ? 1 : 0);
  if (!verified) {
    expect(maintenance!.warnings).toContainEqual(
      expect.stringMatching(/Gateway activation skipped.*gateway status --deep/),
    );
  }
});
