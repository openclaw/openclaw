import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";

function lastEmbeddedLane(): string | undefined {
  const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls.at(-1)?.[0] as { lane?: string } | undefined)?.lane;
}

async function runLaneCase(home: string, lane?: string) {
  const storePath = await writeSessionStoreEntries(home, {
    "agent:main:main": {
      sessionId: "main-session",
      updatedAt: Date.now(),
      lastProvider: "webchat",
      lastTo: "",
    },
  });
  mockAgentPayloads([{ text: "ok" }]);

  await runCronIsolatedAgentTurn({
    cfg: makeCfg(home, storePath),
    deps: createCliDeps(),
    job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
    message: "do it",
    sessionKey: "cron:job-1",
    ...(lane === undefined ? {} : { lane }),
  });

  return lastEmbeddedLane();
}

describe("runCronIsolatedAgentTurn lane selection", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  it("moves the cron lane to nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home, "cron")).toBe("cron-nested");
    });
  });

  it("defaults missing lanes to nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home)).toBe("cron-nested");
    });
  });

  it("preserves non-cron lanes for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home, "subagent")).toBe("subagent");
    });
  });
});
