import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../cron/proactive-job.test-support.js";
import { getStatusSummary } from "../status/summary.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const AGENT_COUNT = 200;

/** Every receipt-owned job takes the owner-route lookup. */
function makeFleetConfig(storePath: string, utilityModel?: string): OpenClawConfig {
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
  for (let index = 0; index < AGENT_COUNT; index += 1) {
    entries[`agent-${index}`] = {};
  }
  return {
    agents: {
      ownership: "explicit",
      defaults: { utilityModel },
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
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it.each([undefined, "openai/gpt-test"])(
    "projects fleet status without re-walking the roster per agent (utility model: %s)",
    async (utilityModel) =>
      withOpenClawTestState({ label: "status-job-roster" }, async (state) => {
        // An absent store keeps the read-only route probe empty; only roster work is under test.
        const storePath = state.statePath("sessions.json");
        const cfg = makeFleetConfig(storePath, utilityModel);
        const jobs = Object.keys(cfg.agents!.entries!).map((agentId) =>
          createDefaultProactiveJob(cfg, agentId, 1),
        );
        await saveProactiveJobsForTest(state.statePath("cron", "jobs.json"), jobs);
        const counted = countRosterReads(cfg);

        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: counted.cfg,
        });

        expect(summary.heartbeat.agents).toHaveLength(AGENT_COUNT);
        expect(
          summary.heartbeat.agents.every((agent) => agent.enabled && agent.waitingForRoute),
        ).toBe(true);
        // Enrollment plus the owner-route lookup ran per agent before; both must
        // now share one roster pass, so reads stay far below the fleet size.
        expect(counted.reads()).toBeLessThan(AGENT_COUNT);
      }),
  );
});
