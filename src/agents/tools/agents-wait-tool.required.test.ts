import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";

const records = new Map<string, SubagentRunRecord>();
const registryEvents = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  read: vi.fn<(ids: readonly string[]) => Promise<PreparedSubagentRunsRead>>(),
}));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  prepareSubagentRunsByRunIds: registryEvents.read,
}));
vi.mock("../subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) => {
      if (phase === "projection") {
        return actual.subscribeSubagentRunChanges(phase, listener);
      }
      const wake = () => listener({ runIds: undefined, sessionKeys: undefined });
      registryEvents.listeners.add(wake);
      return () => registryEvents.listeners.delete(wake);
    }) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});
function selectRuns(ids: readonly string[]) {
  return new Map(
    ids.flatMap((id) => {
      const entry = records.get(id);
      return entry ? [[id, entry] as const] : [];
    }),
  );
}
function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return { consume: (consume) => ({ ready: true, value: consume(read()) }) };
}
function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

describe("required collector completion", () => {
  beforeEach(() => {
    records.clear();
    registryEvents.listeners.clear();
    registryEvents.read
      .mockReset()
      .mockImplementation(async (ids) => preparedRuns(() => selectRuns(ids)));
  });
  it("keeps required sibling results owned until every registry completion arrives", async () => {
    onTestFinished(resetCodeModeTestState);
    const first = collectorRun("first-required", "agent:main:main", { status: "done" });
    const second = collectorRun("second-required", "agent:main:main");
    records.set(first.runId, first);
    records.set(second.runId, second);
    const read = createDeferred();
    registryEvents.read.mockImplementation(async (ids) => {
      read.resolve();
      return preparedRuns(() => selectRuns(ids));
    });
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createMainSessionWaitTool()] });
    let settled = false;
    const result = expectDefined(h.tools[0], "exec")
      .execute("required-child-results", {
        title: "Collect required child results",
        required: true,
        code: 'return await agents_wait({ids:["first-required", "second-required"]});',
      })
      .then((value) => {
        settled = true;
        return value;
      });
    try {
      await read.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(registryEvents.read).toHaveBeenCalledOnce();
      second.completion = { required: false, resultText: "child failure evidence" };
      second.collectorCompletion = { status: "failed" };
      for (const listener of registryEvents.listeners) {
        listener();
      }
      vi.useRealTimers();
      await expect(result).resolves.toMatchObject({
        details: {
          status: "completed",
          value: {
            pending: [],
            completed: [
              { runId: first.runId, status: "done" },
              { runId: second.runId, status: "failed", result: "child failure evidence" },
            ],
          },
        },
      });
      expect(registryEvents.read).toHaveBeenCalledTimes(2);
      expect(registryEvents.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
      second.collectorCompletion = { status: "failed" };
      for (const listener of registryEvents.listeners) {
        listener();
      }
      await result;
    }
  });

  it("cancels required collection without borrowing another requester's child", async () => {
    const entry = collectorRun("foreign-required", "agent:other:main");
    records.set(entry.runId, entry);
    const tool = createMainSessionWaitTool();
    await expect(
      tool.execute("foreign", { ids: [entry.runId], required: true }),
    ).resolves.toMatchObject({
      details: { success: false, errors: [{ runId: entry.runId, error: "not_owner" }] },
    });
    entry.swarmRequesterSessionKey = "agent:main:main";
    const read = createDeferred();
    registryEvents.read.mockImplementation(async (ids) => {
      read.resolve();
      return preparedRuns(() => selectRuns(ids));
    });
    const abort = new AbortController();
    const result = tool.execute(
      "required-abort",
      { ids: [entry.runId], required: true },
      abort.signal,
    );
    const rejected = expect(result).rejects.toThrow("agents_wait aborted");
    await read.promise;
    abort.abort();
    await rejected;
    expect(registryEvents.listeners.size).toBe(0);
    await expect(
      tool.execute("ambiguous-wait", { ids: [entry.runId], required: true, timeoutSeconds: 1 }),
    ).rejects.toThrow("cannot also specify");
  });
});
