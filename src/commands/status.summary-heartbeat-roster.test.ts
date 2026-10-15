import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getStatusSummary } from "../status/summary.js";

const AGENT_COUNT = 200;

vi.mock("../infra/heartbeat-summary-snapshot.js", async (original) => ({
  ...(await original<typeof import("../infra/heartbeat-summary-snapshot.js")>()),
  readHeartbeatSummarySnapshot: async () =>
    Array.from({ length: AGENT_COUNT }, (_, index) =>
      makeCronJob({ id: `job-${index}`, agentId: `agent-${index}`, delivery: { mode: "none" } }),
    ),
}));

/** The compatibility projection reads converted automation jobs for the whole fleet. */
function makeFleetConfig(storePath: string): OpenClawConfig {
  const entries: Record<string, object> = {};
  for (let index = 0; index < AGENT_COUNT; index += 1) {
    entries[`agent-${index}`] = {};
  }
  return {
    agents: {
      ownership: "explicit",
      entries,
    },
    session: { store: storePath },
  };
}

/** Counts how often the roster is read: every walk starts at `agents.entries`. */
function countRosterReads(cfg: OpenClawConfig): { cfg: OpenClawConfig; reads: () => number } {
  let reads = 0;
  const agents = new Proxy(cfg.agents as object, {
    get(target, property, receiver) {
      if (property === "entries") {
        reads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { cfg: { ...cfg, agents: agents as OpenClawConfig["agents"] }, reads: () => reads };
}

describe("getStatusSummary heartbeat roster", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("projects converted jobs for the whole fleet without re-walking the roster per agent", async () => {
    // An absent store keeps the read-only route probe empty; only roster work is under test.
    const storePath = path.join(
      tempDirs.make("openclaw-status-heartbeat-roster-"),
      "sessions.json",
    );
    const counted = countRosterReads(makeFleetConfig(storePath));

    const summary = await getStatusSummary({ includeChannelSummary: false, config: counted.cfg });

    expect(summary.heartbeat.agents).toHaveLength(AGENT_COUNT);
    expect(summary.heartbeat.agents.every((agent) => agent.enabled && !agent.waitingForRoute)).toBe(
      true,
    );
    // The compatibility projection must not re-enroll each agent from configuration.
    expect(counted.reads()).toBeLessThan(AGENT_COUNT);
  });
});
