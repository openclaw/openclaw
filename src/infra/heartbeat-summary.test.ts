import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { publishHeartbeatSummarySnapshot } from "./heartbeat-summary-snapshot.js";
import { resolveHeartbeatSummaryForAgent } from "./heartbeat-summary.js";

describe("deprecated heartbeat summary publication", () => {
  it("projects the primary job until its owner replaces or removes the snapshot", () => {
    const cfg: OpenClawConfig = {};
    const primary = makeCronJob({
      agentId: "ops",
      schedule: { kind: "every", everyMs: 900_000 },
      delivery: { mode: "announce", target: "owner", directPolicy: "block" },
    });
    const converted = makeCronJob({ agentId: "ops", id: "converted", enabled: false });
    publishHeartbeatSummarySnapshot(cfg, [primary, converted]);
    const summary = resolveHeartbeatSummaryForAgent(cfg, "OPS");
    expect(summary).toMatchObject({ enabled: true, everyMs: 900_000, target: "owner" });
    summary.deliveryPolicy!.target = "none";
    expect(resolveHeartbeatSummaryForAgent(cfg, "ops").deliveryPolicy?.target).toBe("owner");
    expect(resolveHeartbeatSummaryForAgent({}, "ops").enabled).toBe(false);

    publishHeartbeatSummarySnapshot(cfg, [{ ...primary, enabled: false }]);
    expect(resolveHeartbeatSummaryForAgent(cfg, "ops")).toMatchObject({
      enabled: false,
      every: "disabled",
      everyMs: null,
    });
    publishHeartbeatSummarySnapshot(cfg, []);
    expect(resolveHeartbeatSummaryForAgent(cfg, "ops")).toMatchObject({
      enabled: false,
      prompt: "",
      target: "none",
    });
  });
});
