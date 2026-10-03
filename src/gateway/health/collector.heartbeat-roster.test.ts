import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { readHeartbeatSummarySnapshot } from "../../infra/heartbeat-summary-snapshot.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

vi.mock("../../infra/heartbeat-summary-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-summary-snapshot.js")>()),
  readHeartbeatSummarySnapshot: vi.fn(),
}));

const AGENT_COUNT = 200;

/** Fleet health should read the automation projection once for the whole roster. */
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

describe("health agent summaries heartbeat roster", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("projects canonical automation state for a fleet from one snapshot", async () => {
    // An absent store keeps the read-only session reader empty; only enrollment is under test.
    const storePath = path.join(
      tempDirs.make("openclaw-health-heartbeat-roster-"),
      "sessions.json",
    );
    const plain = makeFleetConfig(storePath);
    const counted = countRosterReads(plain);
    vi.mocked(readHeartbeatSummarySnapshot).mockResolvedValue([
      {
        id: "converted-heartbeat-agent-7",
        agentId: "agent-7",
        name: "Converted automation",
        createdAtMs: 0,
        updatedAtMs: 0,
        enabled: true,
        schedule: { kind: "every", everyMs: 2_700_000 },
        payload: { kind: "agentTurn", message: "Check the inbox" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        delivery: { mode: "announce", target: "owner" },
        state: {},
      } satisfies CronJob,
    ]);

    const summaries = await buildHealthAgentSummaries(counted.cfg, resolveHealthAgentOrder(plain));

    expect(summaries).toHaveLength(AGENT_COUNT);
    // Per-agent enrollment walks the roster once per agent (and once more per
    // roster member inside that walk); the fleet must stay far below that.
    expect(counted.reads()).toBeLessThan(AGENT_COUNT);
    expect(readHeartbeatSummarySnapshot).toHaveBeenCalledExactlyOnceWith(counted.cfg);
    expect(summaries.filter((summary) => summary.heartbeat.enabled)).toHaveLength(1);
    expect(summaries.find((summary) => summary.agentId === "agent-7")?.heartbeat).toMatchObject({
      enabled: true,
      everyMs: 2_700_000,
      prompt: "Check the inbox",
      target: "owner",
    });
  });
});
