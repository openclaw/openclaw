import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../cron/proactive-job.test-support.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveHeartbeatCliStatus } from "./heartbeat-cli-status.js";

function ownerConfig(extra?: Partial<OpenClawConfig["agents"]>): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" }, userTimezone: "UTC" },
      entries: { main: {} },
      ...extra,
    },
  };
}

describe("resolveHeartbeatCliStatus", () => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
  });

  it("reports disabled when no proactive Automation job remains", async () => {
    await withOpenClawTestState({ label: "hb-status-none" }, async (state) => {
      const cfg = ownerConfig();
      const storePath = state.statePath("cron", "jobs.json");
      await saveProactiveJobsForTest(storePath, []);
      const status = await resolveHeartbeatCliStatus(cfg, {
        nowMs: Date.parse("2026-06-15T12:00:00Z"),
        storePath,
      });
      expect(status.enabled).toBe(false);
      expect(status.jobId).toBeNull();
      expect(status.nextFireAt).toBeNull();
      expect(status.nextFireSource).toBe("disabled");
      expect(status.activeHours).toBeNull();
    });
  });

  it("reports disabled for an explicitly disabled Automation job", async () => {
    await withOpenClawTestState({ label: "hb-status-disabled" }, async (state) => {
      const cfg = ownerConfig();
      const storePath = state.statePath("cron", "jobs.json");
      const job = {
        ...createDefaultProactiveJob(cfg, "main", 1, 30 * 60 * 1000),
        enabled: false,
      };
      await saveProactiveJobsForTest(storePath, [job]);
      const status = await resolveHeartbeatCliStatus(cfg, {
        nowMs: Date.parse("2026-06-15T12:00:00Z"),
        storePath,
      });
      expect(status.enabled).toBe(false);
      expect(status.jobId).toBe(job.id);
      expect(status.nextFireSource).toBe("disabled");
      expect(status.nextFireAt).toBeNull();
    });
  });

  it("reports outside-active-hours from the job window and keeps cadence", async () => {
    await withOpenClawTestState({ label: "hb-status-outside" }, async (state) => {
      const cfg = ownerConfig();
      const storePath = state.statePath("cron", "jobs.json");
      const job = {
        ...createDefaultProactiveJob(cfg, "main", 1, 30 * 60 * 1000),
        activeHours: { start: "22:00", end: "23:00", timezone: "UTC" },
      };
      await saveProactiveJobsForTest(storePath, [job]);
      const status = await resolveHeartbeatCliStatus(cfg, {
        nowMs: Date.parse("2026-06-15T12:00:00Z"),
        storePath,
      });
      expect(status.enabled).toBe(true);
      expect(status.everyMs).toBe(30 * 60 * 1000);
      expect(status.withinActiveHours).toBe(false);
      expect(status.nextFireAt).toBeNull();
      expect(status.nextFireSource).toBe("outside-active-hours");
      expect(status.activeHours).toEqual({ start: "22:00", end: "23:00", timezone: "UTC" });
    });
  });

  it("uses job.state.nextRunAtMs when enabled and inside active hours", async () => {
    await withOpenClawTestState({ label: "hb-status-scheduled" }, async (state) => {
      const nowMs = Date.parse("2026-06-15T12:00:00Z");
      const nextRunAtMs = nowMs + 5 * 60 * 1000;
      const cfg = ownerConfig();
      const storePath = state.statePath("cron", "jobs.json");
      const base = createDefaultProactiveJob(cfg, "main", nowMs, 30 * 60 * 1000);
      const job = {
        ...base,
        activeHours: { start: "00:00", end: "23:59", timezone: "UTC" },
        state: { ...base.state, nextRunAtMs },
      };
      await saveProactiveJobsForTest(storePath, [job]);
      const status = await resolveHeartbeatCliStatus(cfg, { nowMs, storePath });
      expect(status.withinActiveHours).toBe(true);
      expect(status.nextFireSource).toBe("scheduled");
      expect(status.nextFireInMs).toBe(5 * 60 * 1000);
      expect(status.nextFireAt).toBe(new Date(nextRunAtMs).toISOString());
      expect(status.jobId).toBe(job.id);
    });
  });

  it("requires --agent when ownership is ambiguous across multiple enrolled agents", async () => {
    await withOpenClawTestState({ label: "hb-status-ambiguous" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveProactiveJobsForTest(storePath, [
        createDefaultProactiveJob(cfg, "ops", 1),
        createDefaultProactiveJob(cfg, "research", 1),
      ]);
      await expect(resolveHeartbeatCliStatus(cfg, { storePath })).rejects.toBeInstanceOf(
        AgentSelectionRequiredError,
      );
      await expect(resolveHeartbeatCliStatus(cfg, { storePath })).rejects.toThrow(/Pass --agent/);
    });
  });

  it("accepts an explicit --agent when the fleet is ambiguous", async () => {
    await withOpenClawTestState({ label: "hb-status-pick-agent" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
          defaults: { userTimezone: "UTC" },
        },
      };
      const storePath = state.statePath("cron", "jobs.json");
      const ops = createDefaultProactiveJob(cfg, "ops", 1, 30 * 60 * 1000);
      await saveProactiveJobsForTest(storePath, [
        ops,
        createDefaultProactiveJob(cfg, "research", 1, 60 * 60 * 1000),
      ]);
      const status = await resolveHeartbeatCliStatus(cfg, {
        agentId: "ops",
        nowMs: Date.parse("2026-06-15T12:00:00Z"),
        storePath,
      });
      expect(status.agentId).toBe("ops");
      expect(status.enabled).toBe(true);
      expect(status.jobId).toBe(ops.id);
      expect(status.everyMs).toBe(30 * 60 * 1000);
    });
  });

  it("fails cleanly for an unknown agent id", async () => {
    await withOpenClawTestState({ label: "hb-status-unknown" }, async (state) => {
      const cfg = ownerConfig();
      const storePath = state.statePath("cron", "jobs.json");
      await saveProactiveJobsForTest(storePath, [createDefaultProactiveJob(cfg, "main", 1)]);
      await expect(resolveHeartbeatCliStatus(cfg, { agentId: "nope", storePath })).rejects.toThrow(
        /Unknown agent id "nope"/,
      );
    });
  });
});
