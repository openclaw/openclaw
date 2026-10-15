import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import {
  projectHeartbeatSummary,
  readHeartbeatSummarySnapshot,
} from "./heartbeat-summary-snapshot.js";

const receipts = vi.hoisted(() => ({
  read: vi.fn<typeof import("../cron/proactive-job-receipt.js").readDefaultProactiveJobsAsync>(),
}));
// mock-isolation: summary projection consumes a supplied receipt snapshot without opening shared state.
vi.mock("../cron/proactive-job-receipt.js", () => ({
  readDefaultProactiveJobsAsync: receipts.read,
}));
beforeEach(() => receipts.read.mockReset());

describe("protocol v4 automation summary projection", () => {
  it("projects canonical cadence and delivery while disabled or missing jobs stay disabled", () => {
    const primary = makeCronJob({
      agentId: "ops",
      schedule: { kind: "every", everyMs: 900_000 },
      delivery: { mode: "announce", target: "owner", directPolicy: "block" },
    });
    expect(projectHeartbeatSummary(primary)).toMatchObject({
      enabled: true,
      everyMs: 900_000,
      target: "owner",
      deliveryPolicy: { target: "owner", directPolicy: "block" },
    });
    expect(projectHeartbeatSummary({ ...primary, enabled: false })).toMatchObject({
      enabled: false,
      every: "disabled",
      everyMs: null,
    });
    expect(projectHeartbeatSummary()).toMatchObject({
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
    async ({ cfg, sessionKey, expectedAgentId }) => {
      const job = makeCronJob({ sessionKey, delivery: { mode: "none" } });
      receipts.read.mockResolvedValue([job]);
      const snapshot = await readHeartbeatSummarySnapshot(cfg);

      expect(snapshot.map(({ agentId }) => agentId)).toEqual(
        expectedAgentId ? [expectedAgentId] : [],
      );
      expect(job.agentId).toBeUndefined();
    },
  );
});
