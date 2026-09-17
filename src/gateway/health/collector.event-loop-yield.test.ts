import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const AGENT_COUNT = 30;
const SIMULATED_READ_MS = 4;

function busyWaitMs(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Simulate a slow synchronous disk read (e.g. a USB/SMB-backed store).
  }
}

function makeFleetConfig(): OpenClawConfig {
  const entries: Record<string, object> = {};
  for (let index = 0; index < AGENT_COUNT; index += 1) {
    entries[`agent-${index}`] = {};
  }
  return { agents: { ownership: "explicit", entries } };
}

describe("health agent summaries event loop yield", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("lets queued macrotasks interleave with slow per-agent session store reads (#149931)", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-health-event-loop-yield-"));
    const cfg = makeFleetConfig();
    const order = resolveHealthAgentOrder(cfg);

    // Warm every lazily-imported module the collector touches on its first
    // call, so the measured run below isn't skewed by one-time import cost.
    await buildHealthAgentSummaries(cfg, order);

    const reads = vi.spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly");
    reads.mockImplementation((scope, options) => {
      busyWaitMs(SIMULATED_READ_MS);
      return {
        count: 0,
        recent: [],
        byAgent: new Map(options.agentIds.map((agentId) => [agentId, { count: 0, recent: [] }])),
      };
    });

    let ticks = 0;
    let scheduling = true;
    const scheduleTick = () => {
      if (!scheduling) {
        return;
      }
      setImmediate(() => {
        ticks += 1;
        scheduleTick();
      });
    };
    scheduleTick();

    const summaries = await buildHealthAgentSummaries(cfg, order);
    scheduling = false;

    expect(summaries).toHaveLength(AGENT_COUNT);
    expect(reads).toHaveBeenCalledTimes(AGENT_COUNT);
    // Each simulated read blocks the thread for SIMULATED_READ_MS; a loop that
    // never yields lets zero queued macrotasks run while it processes the
    // whole fleet. A loop that yields after every entry must let the
    // scheduled ticker run close to once per agent.
    expect(ticks).toBeGreaterThan(AGENT_COUNT / 2);
  });
});
