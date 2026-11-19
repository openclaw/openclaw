import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  captureActiveAgentToolUsageRuns,
  createRunToolUsageRecorder,
  discardPendingAgentToolUsage,
  type RunToolUsageRecorder,
} from "./tool-usage-recorder.js";

const storage = vi.hoisted(() => ({
  readAgentToolUsageStatus: vi.fn(),
  flushAgentToolUsage: vi.fn(),
}));
// mock-isolation: only the recorder's persistence boundary is replaced; no database/runtime boot.
vi.mock("../config/sessions/tool-usage.js", () => storage);

const config: OpenClawConfig = {
  agents: { defaults: { experimental: { usageRankedToolIndex: true } } },
};
const recorders: RunToolUsageRecorder[] = [];
const warn = vi.fn();
function createRecorder(agentId = "main") {
  const recorder = createRunToolUsageRecorder({
    agentId,
    runId: `${agentId}-synthetic-run`,
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
function admittedRecorder(agentId = "main") {
  const recorder = createRecorder(agentId);
  expect(recorder.bindTranscript({ agentId })).toBeUndefined();
  expect(recorder.takeAppend()).toEqual({
    kind: "begin",
    runId: `${agentId}-synthetic-run`,
    now: 1_000,
  });
  recorder.committed(1);
  return recorder;
}

beforeEach(() => {
  storage.readAgentToolUsageStatus.mockReset().mockResolvedValue({ generation: 1 });
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
  ])("does not admit storage when disabled or incognito: %j", (input) => {
    expect(
      createRunToolUsageRecorder({
        ...input,
        agentId: "main",
        runId: "synthetic-run",
        log: { warn },
      }),
    ).toBeUndefined();
    expect(storage.readAgentToolUsageStatus).not.toHaveBeenCalled();
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
    expect(captureActiveAgentToolUsageRuns("main")).toEqual([]);
  });

  it("co-commits admission and bounded deltas without separate worker requests", async () => {
    const recorder = admittedRecorder();
    expect(captureActiveAgentToolUsageRuns("main")).toEqual(["main-synthetic-run"]);
    expect(recorder.takeAppend()).toBeUndefined();
    recorder.record("openclaw:notes:lookup");
    recorder.record("openclaw:notes:lookup");
    recorder.record("openclaw:core:read");
    expect(recorder.takeAppend()).toEqual({
      kind: "flush",
      runId: "main-synthetic-run",
      generation: 1,
      rows: [
        { toolId: "openclaw:notes:lookup", score: 2, updatedAt: 1_000 },
        { toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 },
      ],
      now: 1_000,
    });
    expect(recorder.takeAppend()).toBeUndefined();
    await recorder.settle();
    expect(storage.readAgentToolUsageStatus).not.toHaveBeenCalled();
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
    expect(captureActiveAgentToolUsageRuns("main")).toEqual([]);
    recorder.record("openclaw:core:read");
    expect(recorder.takeAppend()).toBeUndefined();
  });

  it("keeps import exclusion before admission and never replays an uncertain append", async () => {
    const recorder = createRecorder();
    expect(captureActiveAgentToolUsageRuns("main")).toEqual(["main-synthetic-run"]);
    expect(recorder.bindTranscript({ agentId: "main" })).toBeUndefined();
    recorder.record("openclaw:core:read");
    expect(recorder.takeAppend()?.kind).toBe("begin");
    recorder.committed(1);
    expect(recorder.takeAppend()).toMatchObject({
      kind: "flush",
      rows: [{ toolId: "openclaw:core:read", score: 1 }],
    });
    // No committed receipt arrives for this submitted batch.
    await recorder.settle();
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
  });

  it("fences captured and buffered batches without changing another agent", async () => {
    const main = admittedRecorder();
    const helper = admittedRecorder("helper");
    main.record("openclaw:notes:lookup");
    const submitted = main.takeAppend();
    main.record("openclaw:notes:lookup");
    helper.record("openclaw:notes:lookup");
    discardPendingAgentToolUsage("main", 2);
    main.committed(1);
    main.record("openclaw:core:read");
    expect(submitted).toMatchObject({ generation: 1 });
    expect(main.takeAppend()).toMatchObject({
      generation: 2,
      rows: [{ toolId: "openclaw:core:read", score: 1 }],
    });
    expect(helper.takeAppend()).toMatchObject({
      generation: 1,
      rows: [{ toolId: "openclaw:notes:lookup", score: 1 }],
    });
    await Promise.all([main.settle(), helper.settle()]);
    expect(storage.flushAgentToolUsage).not.toHaveBeenCalled();
  });

  it("keeps late counts in their captured generation when reset races settlement admission", async () => {
    const recorder = admittedRecorder();
    recorder.record("openclaw:core:read");
    const settling = recorder.settle();
    discardPendingAgentToolUsage("main", 2);
    await settling;
    expect(storage.flushAgentToolUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        generation: 1,
        rows: [{ toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 }],
      }),
    );
  });

  it("retains canonical counter ownership for foreign transcripts and fences delayed admission", async () => {
    const release = Promise.withResolvers<{ generation: number }>();
    storage.readAgentToolUsageStatus.mockReturnValueOnce(release.promise);
    const recorder = createRecorder();
    const bound = recorder.bindTranscript({ agentId: "shared-transcript-owner" });
    recorder.record("openclaw:notes:lookup");
    discardPendingAgentToolUsage("main", 2);
    recorder.record("openclaw:core:read");
    release.resolve({ generation: 1 });
    await bound;
    expect(recorder.takeAppend()).toBeUndefined();
    await recorder.settle();
    expect(storage.flushAgentToolUsage).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      runId: "main-synthetic-run",
      config,
      generation: 2,
      startedAt: 1_000,
      rows: [{ toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 }],
      now: 1_000,
    });
  });

  it("joins late counts through retained settlement and closes recording before its wait", async () => {
    const owner = new AsyncWorkScope();
    const release = Promise.withResolvers<boolean>();
    storage.flushAgentToolUsage.mockReturnValueOnce(release.promise);
    const recorder = admittedRecorder();
    recorder.record("openclaw:core:read");
    const settling = owner.run(() => recorder.settle());
    const drained = owner.drain();
    recorder.record("openclaw:notes:lookup");
    release.resolve(true);
    await settling;
    await drained;
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(1);
    expect(storage.flushAgentToolUsage.mock.calls[0]?.[0].rows).toEqual([
      { toolId: "openclaw:core:read", score: 1, updatedAt: 1_000 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains a foreign-store live-run receipt even without successful calls", async () => {
    const recorder = createRecorder();
    await recorder.bindTranscript();
    await recorder.settle();
    expect(storage.flushAgentToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, rows: [], runId: "main-synthetic-run" }),
    );
  });

  it("warns and drops unavailable or uncertain settlement rather than retrying", async () => {
    const recorder = admittedRecorder();
    recorder.record("openclaw:notes:lookup");
    storage.flushAgentToolUsage.mockRejectedValueOnce(new Error("writer unavailable"));
    const settling = recorder.settle();
    expect(recorder.settle()).toBe(settling);
    await settling;
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool usage flush failed"));
    storage.readAgentToolUsageStatus.mockRejectedValueOnce(new Error("reader unavailable"));
    const unavailable = createRecorder();
    await unavailable.bindTranscript();
    unavailable.record("openclaw:notes:lookup");
    await unavailable.settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool usage recording unavailable"));
    expect(storage.flushAgentToolUsage).toHaveBeenCalledTimes(1);
  });
});
