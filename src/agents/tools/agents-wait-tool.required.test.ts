import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import {
  collectorRun,
  createMainSessionWaitTool,
  preparedRuns,
  selectRuns,
} from "./agents-wait-tool.test-support.js";

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
function observeRead() {
  const read = createDeferred();
  registryEvents.read.mockImplementation(async (ids) => {
    read.resolve();
    return preparedRuns(() => selectRuns(records, ids));
  });
  return read.promise;
}
function publishCompletion(entry: SubagentRunRecord) {
  entry.collectorCompletion = { status: "failed" };
  for (const listener of registryEvents.listeners) {
    listener();
  }
}
beforeEach(() => {
  records.clear();
  registryEvents.listeners.clear();
  registryEvents.read
    .mockReset()
    .mockImplementation(async (ids) => preparedRuns(() => selectRuns(records, ids)));
});
it.each(["cell", "nested"])(
  "keeps sibling results owned with %s awaitResults until every completion arrives",
  async (mode) => {
    onTestFinished(resetCodeModeTestState);
    const first = collectorRun("first-required", "agent:main:main", { status: "done" });
    const second = collectorRun("second-required", "agent:main:main");
    records.set(first.runId, first);
    records.set(second.runId, second);
    const read = observeRead();
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createMainSessionWaitTool()] });
    const result = expectDefined(h.tools[0], "exec").execute("required-child-results", {
      title: "Collect required child results",
      awaitResults: mode === "cell",
      code: `return await agents_wait({ids:["first-required", "second-required"]${mode === "nested" ? ", awaitResults: true" : ""}});`,
    });
    try {
      await read;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(60_000);
      const pending = Symbol("pending");
      expect(await Promise.race([result, Promise.resolve(pending)])).toBe(pending);
      expect(registryEvents.read).toHaveBeenCalledOnce();
      second.completion = { required: false, resultText: "child failure evidence" };
      publishCompletion(second);
      vi.useRealTimers();
      expect((await result).details).toMatchObject({
        status: "completed",
        value: {
          pending: [],
          completed: [
            { runId: first.runId, status: "done" },
            { runId: second.runId, status: "failed", result: "child failure evidence" },
          ],
        },
      });
      expect(registryEvents.read).toHaveBeenCalledTimes(2);
      expect(registryEvents.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
      publishCompletion(second);
      await result;
    }
  },
);

it("cancels required collection without borrowing another requester's child", async () => {
  const entry = collectorRun("foreign-required", "agent:other:main");
  records.set(entry.runId, entry);
  const tool = createMainSessionWaitTool();
  await expect(
    tool.execute("foreign", { ids: [entry.runId], awaitResults: true }),
  ).resolves.toMatchObject({
    details: { success: false, errors: [{ runId: entry.runId, error: "not_owner" }] },
  });
  entry.swarmRequesterSessionKey = "agent:main:main";
  const read = observeRead();
  const abort = new AbortController();
  const result = tool.execute(
    "required-abort",
    { ids: [entry.runId], awaitResults: true },
    abort.signal,
  );
  const rejected = expect(result).rejects.toThrow("agents_wait aborted");
  await read;
  abort.abort();
  await rejected;
  expect(registryEvents.listeners.size).toBe(0);
  await expect(
    tool.execute("ambiguous-wait", { ids: [entry.runId], awaitResults: true, timeoutSeconds: 1 }),
  ).rejects.toThrow("cannot also specify");
});
