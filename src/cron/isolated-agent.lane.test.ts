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

async function runLaneCase(home: string, lane?: string, isManualRun?: boolean) {
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
    isManualRun,
  });

  return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
}

describe("runCronIsolatedAgentTurn lane selection", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  it("moves the cron lane to nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      const args = await runLaneCase(home, "cron");
      expect(args?.lane).toBe("nested");
      expect(args?.enqueue).toBeUndefined();
    });
  });

  it("bypasses lane enqueue when isManualRun=true and lane=cron", async () => {
    await withTempCronHome(async (home) => {
      const args = await runLaneCase(home, "cron", true);
      expect(args?.lane).toBe("nested");
      expect(args?.enqueue).toBeDefined();

      const task = vi.fn(async () => "ok");
      const res = await args?.enqueue?.(task);
      expect(res).toBe("ok");
      expect(task).toHaveBeenCalled();
    });
  });

  it("does NOT bypass lane enqueue when isManualRun=true but lane is NOT cron", async () => {
    await withTempCronHome(async (home) => {
      const args = await runLaneCase(home, "main", true);
      expect(args?.lane).toBe("main");
      expect(args?.enqueue).toBeUndefined();
    });
  });

  it("defaults missing lanes to nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      const args = await runLaneCase(home);
      expect(args?.lane).toBe("nested");
      expect(args?.enqueue).toBeUndefined();
    });
  });

  it("preserves non-cron lanes for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      const args = await runLaneCase(home, "subagent");
      expect(args?.lane).toBe("subagent");
      expect(args?.enqueue).toBeUndefined();
    });
  });
});
