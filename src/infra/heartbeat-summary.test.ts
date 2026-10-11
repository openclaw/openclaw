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

  const ownershipCases: Array<{
    label: string;
    cfg: OpenClawConfig;
    sessionKey?: string;
    expectedAgentId?: string;
  }> = [
    {
      label: "sole agent",
      cfg: { agents: { ownership: "explicit", entries: { ops: {} } } },
      expectedAgentId: "ops",
    },
    {
      label: "configured system owner",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: {}, ops: {} },
        },
      },
      expectedAgentId: "ops",
    },
    {
      label: "scoped session owner before the default",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      },
      sessionKey: "agent:ops:main",
      expectedAgentId: "ops",
    },
    {
      label: "unresolved multi-agent owner",
      cfg: { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } },
    },
  ];

  it.each(ownershipCases)(
    "projects an omitted job owner without guessing: $label",
    ({ cfg, sessionKey, expectedAgentId }) => {
      const job = makeCronJob({ sessionKey, delivery: { mode: "none" } });
      publishHeartbeatSummarySnapshot(cfg, [job]);

      for (const agentId of ["main", "ops"]) {
        expect(resolveHeartbeatSummaryForAgent(cfg, agentId).enabled).toBe(
          agentId === expectedAgentId,
        );
      }
      expect(job.agentId).toBeUndefined();
    },
  );
});
