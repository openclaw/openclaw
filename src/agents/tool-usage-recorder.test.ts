import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createRunToolUsageRecorder,
  discardPendingAgentToolUsage,
  type RunToolUsageRecorder,
} from "./tool-usage-recorder.js";

const storage = vi.hoisted(() => ({
  beginAgentToolUsageRecording: vi.fn(),
  flushAgentToolUsage: vi.fn(),
}));
// mock-isolation: only the recorder's persistence boundary is replaced; no database/runtime boot.
vi.mock("../config/sessions/tool-usage.js", () => storage);

const config: OpenClawConfig = {
  agents: { defaults: { experimental: { usageRankedToolIndex: true } } },
};
const recorders: RunToolUsageRecorder[] = [];
const warn = vi.fn();
async function createRecorder(agentId = "main") {
  const recorder = await createRunToolUsageRecorder({
    agentId,
    runId: "synthetic-run",
    config,
    sessionKey: `agent:${agentId}:usage-test`,
    log: { warn },
    now: () => 1_000,
  });
  if (!recorder) {
    throw new Error("expected enabled recorder");
  }
  recorders.push(recorder);
  return recorder;
}

beforeEach(() => {
  storage.beginAgentToolUsageRecording
    .mockReset()
    .mockResolvedValue({ generation: 1, liveSince: 1_000 });
  storage.flushAgentToolUsage.mockReset().mockResolvedValue(true);
  warn.mockReset();
});
afterEach(async () => {
  await Promise.all(recorders.splice(0).map((recorder) => recorder.settle()));
});

describe("run-owned tool usage", () => {
  it.each([
    { config: undefined, sessionKey: "agent:main:usage-test" },
    { config: {}, sessionKey: "agent:main:usage-test" },
    {
      config: { agents: { defaults: { experimental: { usageRankedToolIndex: false } } } },
      sessionKey: "agent:main:usage-test",
    },
    { config, sessionKey: "agent:main:dashboard:incognito-usage-test" },
  ])("does not admit storage when disabled or incognito: %j", async (input) => {
    expect(
      await createRunToolUsageRecorder({
        ...input,
        agentId: "main",
        runId: "synthetic-run",
        log: { warn },
      }),
    ).toBeUndefined();
    expect(storage.beginAgentToolUsageRecording).not.toHaveBeenCalled();
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
  });

  it("coalesces slow turn flushes without blocking completion or retaining per-call rows", async () => {
    const release = Promise.withResolvers<boolean>();
    storage.flushAgentToolUsage.mockImplementationOnce(() => release.promise);
    const recorder = await createRecorder();
    recorder.record("openclaw:notes:lookup");
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
    const first = recorder.flush();
    recorder.record("openclaw:notes:lookup");
    const second = recorder.flush();
    recorder.record("openclaw:notes:lookup");
    recorder.record("openclaw:core:read");
    void recorder.flush();
    expect(second).toBe(first);
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(1);
    release.resolve(true);
    await second;
    expect(storage.flushAgentToolUsage.mock.calls.map(([batch]) => batch.rows)).toEqual([
      [{ toolId: "openclaw:notes:lookup", score: 1, updatedAt: 1_000 }],
      [
        { toolId: "openclaw:notes:lookup", score: 2, updatedAt: 1_000 },
        { toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 },
      ],
    ]);
    recorder.record("openclaw:notes:lookup");
    await recorder.settle();
    recorder.record("openclaw:notes:lookup");
    await recorder.flush();
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(3);
  });

  it("retains a turn arriving between drain completion and promise settlement", async () => {
    const release = Promise.withResolvers<boolean>();
    storage.flushAgentToolUsage.mockImplementationOnce(() => release.promise);
    const recorder = await createRecorder();
    recorder.record("openclaw:notes:lookup");
    const drained = recorder.flush();
    void release.promise.then(() => {
      recorder.record("openclaw:core:read");
      void recorder.flush();
    });
    release.resolve(true);
    await drained;
    expect(storage.flushAgentToolUsage.mock.calls.map(([batch]) => batch.rows)).toEqual([
      [{ toolId: "openclaw:notes:lookup", score: 1, updatedAt: 1_000 }],
      [{ toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 }],
    ]);
  });

  it("discards pending counts on reset while retaining another agent's counts", async () => {
    const main = await createRecorder();
    const sibling = await createRecorder();
    const helper = await createRecorder("helper");
    const release = Promise.withResolvers<boolean>();
    storage.flushAgentToolUsage.mockImplementationOnce(() => release.promise);
    main.record("openclaw:notes:lookup");
    void main.flush();
    for (const recorder of [main, sibling, helper]) {
      recorder.record("openclaw:notes:lookup");
    }
    discardPendingAgentToolUsage("main", 2);
    main.record("openclaw:core:read");
    const settled = Promise.all([main.settle(), sibling.settle(), helper.settle()]);
    release.resolve(false);
    await settled;
    expect(
      storage.flushAgentToolUsage.mock.calls.map(([batch]) => ({
        agentId: batch.agentId,
        generation: batch.generation,
        rows: batch.rows,
      })),
    ).toEqual([
      {
        agentId: "main",
        generation: 1,
        rows: [{ toolId: "openclaw:notes:lookup", score: 1, updatedAt: 1_000 }],
      },
      {
        agentId: "helper",
        generation: 1,
        rows: [{ toolId: "openclaw:notes:lookup", score: 1, updatedAt: 1_000 }],
      },
      {
        agentId: "main",
        generation: 2,
        rows: [{ toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 }],
      },
    ]);
  });

  it("warns and drops an uncertain batch rather than retrying it", async () => {
    const recorder = await createRecorder();
    storage.flushAgentToolUsage.mockRejectedValueOnce(new Error("writer unavailable"));
    recorder.record("openclaw:notes:lookup");
    await recorder.flush();
    await recorder.settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool usage flush failed"));
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(1);
    storage.beginAgentToolUsageRecording.mockRejectedValueOnce(new Error("admission failed"));
    expect(
      await createRunToolUsageRecorder({
        agentId: "main",
        runId: "synthetic-run",
        config,
        log: { warn },
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool usage recording unavailable"));
  });
});
