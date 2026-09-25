import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { typeCheckSources } from "../../../test/helpers/typescript.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "../code-mode.test-support.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";

const records = new Map<string, SubagentRunRecord>();
type ReadRuns = (runIds: readonly string[]) => Promise<PreparedSubagentRunsRead>;
const registryEvents = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  read: vi.fn<ReadRuns>(),
  subscribe: vi.fn<(listener: () => void) => () => void>(),
}));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  prepareSubagentRunsByRunIds: registryEvents.read,
}));

vi.mock("../subagents/registry/subagent-registry-state.js", () => ({
  onSubagentRegistryPersisted: registryEvents.subscribe,
}));

import { isToolResultError } from "../tool-result-error.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";

function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

function waitAtBoundary(boundary: "tool" | "bridge", runId: string, signal?: AbortSignal) {
  return boundary === "tool"
    ? createMainSessionWaitTool()
        .execute("wait", { ids: [runId], timeoutSeconds: 1 }, signal)
        .then((result) => result.details)
    : waitForCollectorCompletion({
        runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        currentAgentId: "main",
        signal,
      });
}

function selectRuns(runIds: readonly string[]): Map<string, SubagentRunRecord> {
  return new Map(
    runIds.flatMap((runId) => {
      const entry =
        records.get(runId) ??
        [...records.values()].find((candidate) => candidate.swarmRunId === runId);
      return entry ? [[runId, entry] as const] : [];
    }),
  );
}

function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return {
    consume: (consume) => ({ ready: true, value: consume(read()) }),
  };
}

describe("agents_wait", () => {
  beforeEach(() => {
    records.clear();
    registryEvents.listeners.clear();
    registryEvents.subscribe.mockReset().mockImplementation((listener) => {
      registryEvents.listeners.add(listener);
      return () => registryEvents.listeners.delete(listener);
    });
    registryEvents.read
      .mockReset()
      .mockImplementation(async (runIds) => preparedRuns(() => selectRuns(runIds)));
  });

  it("composes real collector outputs through discovery, describe, and generated declarations", async () => {
    onTestFinished(resetCodeModeTestState);
    const entry = collectorRun("ready", "agent:main:main", {
      status: "done",
      structured: { answer: 42 },
    });
    records.set(entry.runId, entry);
    const h = createCodeModeHarness();
    const tool = createMainSessionWaitTool();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const execTool = expectDefined(h.tools[0], "Code Mode exec");
    const waitTool = expectDefined(h.tools[1], "Code Mode wait");
    expect(execTool.description).toContain("completed: Array<");
    const listed = await runUntilCompleted({
      execTool,
      waitTool,
      code: 'return await API.list("tools");',
    });
    expect(listed).toMatchObject({
      status: "completed",
      value: { files: [{ path: "tools/agents_wait.d.ts" }] },
      telemetry: { describeCount: 0, callCount: 0 },
    });
    const result = await runUntilCompleted({
      execTool,
      waitTool,
      code: 'const [wait] = await catalog.search("agents_wait"); const description = await wait.describe(); const file = await API.read("tools/agents_wait.d.ts"); const result = await wait({ids:["ready"],timeoutSeconds:0}); return {description, file, ids:result.completed.map(item=>item.runId), structured:result.completed[0].structured};',
    });
    expect(result).toMatchObject({
      status: "completed",
      telemetry: { describeCount: 2, callCount: 1 },
      value: {
        ids: ["ready"],
        structured: { answer: 42 },
        description: { outputSchema: tool.outputSchema },
      },
    });
    const { file } = result.value as { file: { content: string } };
    // Consume the intact guest declaration, with opaque collector-specific output.
    expect(file.content).not.toContain("truncated: true");
    const fileName = "/collector-consumer.ts";
    const source =
      file.content +
      "\n" +
      [
        "async function consume() {",
        'const result = await agents_wait({ids:["ready"]});',
        "const ids: string[] = result.completed.map(item => item.runId);",
        "// @ts-expect-error No invented builds field.",
        "result.builds.map(item => item.id);",
        "// @ts-expect-error Collector structured output is unknown without its own schema.",
        "result.completed[0].structured.answer;",
        "return ids;",
        "}",
        "// @ts-expect-error Required ids stay required.",
        "agents_wait({});",
      ].join("\n");
    expect(typeCheckSources({ [fileName]: source })).toEqual([]);
  });

  it("settles a parked collector bridge from a registry write event", async () => {
    const entry = collectorRun("event-driven", "agent:main:main");
    records.set(entry.runId, entry);
    const completion = waitForCollectorCompletion({
      runId: entry.runId,
      currentSessionKeys: new Set(["agent:main:main"]),
    });

    entry.completion = { required: false, resultText: "event result" };
    entry.collectorCompletion = { status: "done" };
    for (const listener of registryEvents.listeners) {
      listener();
    }

    await expect(completion).resolves.toMatchObject({
      runId: "event-driven",
      status: "done",
      result: "event result",
    });
    expect(registryEvents.listeners.size).toBe(0);
  });

  it("returns retained visible output when a successful collector ends with NO_REPLY", async () => {
    const entry = collectorRun("retained", "agent:main:main", { status: "done" });
    entry.execution = { status: "terminal", outcome: { status: "ok" } };
    entry.completion = {
      required: false,
      resultText: "NO_REPLY",
      fallbackResultText: "retained collector result",
    };
    records.set(entry.runId, entry);

    await expect(
      waitForCollectorCompletion({
        runId: entry.runId,
        currentSessionKeys: new Set(["agent:main:main"]),
      }),
    ).resolves.toMatchObject({ result: "retained collector result" });
  });

  it.each(["before completed read", "listener registration"] as const)(
    "rejects the bridge when abort wins at %s",
    async (timing) => {
      const entry = collectorRun(
        "abort-race",
        "agent:main:main",
        timing === "before completed read" ? { status: "done" } : undefined,
      );
      records.set(entry.runId, entry);
      const controller = new AbortController();
      if (timing === "before completed read") {
        controller.abort();
      } else {
        const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
          controller.abort();
          originalAddEventListener(...args);
        });
      }

      await expect(
        waitForCollectorCompletion({
          runId: entry.runId,
          currentSessionKeys: new Set(["agent:main:main"]),
          signal: controller.signal,
        }),
      ).rejects.toThrow("agents.run wait aborted");
      expect(registryEvents.listeners.size).toBe(0);
    },
  );

  it("returns the first completed child and leaves siblings pending", async () => {
    records.set("one", collectorRun("one", "agent:main:main"));
    records.set("two", collectorRun("two", "agent:main:main"));
    const tool = createMainSessionWaitTool();
    setTimeout(() => {
      const entry = records.get("two");
      if (!entry) {
        return;
      }
      entry.completion = { required: false, resultText: "result-two" };
      entry.collectorCompletion = {
        status: "done",
        structured: { winner: 2 },
      };
      for (const listener of registryEvents.listeners) {
        listener();
      }
    }, 5);

    const result = await tool.execute("call", { ids: ["one", "two"], timeoutSeconds: 1 });
    expect(result.details).toEqual({
      completed: [
        {
          runId: "two",
          status: "done",
          result: "result-two",
          structured: { winner: 2 },
          sessionKey: "agent:worker:subagent:two",
        },
      ],
      pending: ["one"],
    });
  });

  it("parks without reading until a registry mutation wakes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const entry = collectorRun("local-wake", "agent:main:main");
    records.set(entry.runId, entry);
    const controller = new AbortController();
    const tool = createMainSessionWaitTool();
    const reads = vi.spyOn(records, "get");
    const initialRead = createDeferred();
    registryEvents.read.mockImplementationOnce(async (runIds) =>
      preparedRuns(() => {
        const selected = selectRuns(runIds);
        initialRead.resolve();
        return selected;
      }),
    );
    let result: unknown;
    const waiting = tool
      .execute("call", { ids: [entry.runId], timeoutSeconds: 1 }, controller.signal)
      .then((value) => {
        result = value.details;
      });
    try {
      await initialRead.promise;
      const initialReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(750);
      expect(reads).toHaveBeenCalledTimes(initialReads);
      entry.collectorCompletion = { status: "done" };
      for (const listener of registryEvents.listeners) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ completed: [{ runId: entry.runId }], pending: [] });
      expect(registryEvents.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      reads.mockRestore();
      controller.abort();
      await waiting.catch(() => {});
      vi.useRealTimers();
    }
  });

  it("projects an authorized collector failure without failing a mixed batch", async () => {
    const failed = collectorRun("failed", "agent:main:main", {
      status: "failed",
      structured: { partial: true },
    });
    failed.execution = {
      status: "terminal",
      outcome: { status: "error", error: "provider failed after tool output" },
    };
    failed.completion = { required: false, resultText: null, capturedAt: 10 };
    records.set(failed.runId, failed);
    records.set("pending", collectorRun("pending", "agent:main:main"));
    const tool = createMainSessionWaitTool();

    const result = await tool.execute("call", {
      ids: [failed.runId, "pending"],
      timeoutSeconds: 0,
    });

    expect(result.details).toEqual({
      completed: [
        {
          runId: failed.runId,
          status: "failed",
          result: "",
          structured: { partial: true },
          error: "provider failed after tool output",
          sessionKey: failed.childSessionKey,
        },
      ],
      pending: ["pending"],
    });
    expect(isToolResultError(result)).toBe(false);
  });

  it.each([-60_000, 60_000])(
    "keeps its elapsed deadline after a %d ms clock step",
    async (step) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(100_000);
      const controller = new AbortController();
      records.set("clock-step", collectorRun("clock-step", "agent:main:main"));
      const tool = createMainSessionWaitTool();
      let result: unknown;
      const waiting = tool
        .execute("clock", { ids: ["clock-step"], timeoutSeconds: 0.1 }, controller.signal)
        .then((value) => {
          result = value.details;
        });
      try {
        await vi.advanceTimersByTimeAsync(25);
        vi.setSystemTime(Date.now() + step);
        await vi.advanceTimersByTimeAsync(74);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toEqual({ completed: [], pending: ["clock-step"] });
      } finally {
        controller.abort();
        await waiting.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it("orders completions by durable capture time with input-order ties", async () => {
    const later = collectorRun("later", "agent:main:main", { status: "done" });
    later.completion = { required: false, resultText: "later", capturedAt: 10 };
    const earlier = collectorRun("earlier", "agent:main:main", { status: "done" });
    earlier.completion = { required: false, resultText: "earlier", capturedAt: 5 };
    records.set(later.runId, later);
    records.set(earlier.runId, earlier);
    const tool = createMainSessionWaitTool();

    const result = await tool.execute("call", {
      ids: ["later", "earlier"],
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      completed: [{ runId: "earlier" }, { runId: "later" }],
      pending: [],
    });

    const tied = collectorRun("tied", "agent:main:main", { status: "done" });
    tied.completion = { required: false, resultText: "tied", capturedAt: 5 };
    records.set(tied.runId, tied);
    records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "done" }));
    records.set("pending-one", collectorRun("pending-one", "agent:main:main"));
    records.set("pending-two", collectorRun("pending-two", "agent:main:main"));

    const mixed = await tool.execute("mixed", {
      ids: ["later", "missing", "tied", "pending-two", "foreign", "earlier", "pending-one"],
      timeoutSeconds: 0,
    });

    expect(mixed.details).toMatchObject({
      completed: [{ runId: "tied" }, { runId: "earlier" }, { runId: "later" }],
      pending: ["pending-two", "pending-one"],
      errors: [
        { runId: "missing", error: "not_found" },
        { runId: "foreign", error: "not_owner" },
      ],
    });
    expect(isToolResultError(mixed)).toBe(false);
  });

  it("is idempotent and returns per-id ownership and unknown errors", async () => {
    const done = collectorRun("done", "agent:worker:subagent:owner", { status: "done" });
    done.swarmWaitOwnerSessionKeys = ["agent:worker:subagent:owner", "agent:main:main"];
    records.set("done", done);
    records.set("owner", collectorRun("owner", "agent:main:main"));
    records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "failed" }));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: { enabled: true, waitTimeoutSecondsMax: 1 } } },
    });

    const first = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    const second = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    expect(second.details).toEqual(first.details);
    expect(first.details).toMatchObject({
      completed: [{ runId: "done", status: "done" }],
      pending: [],
      errors: [
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ],
    });
    expect(isToolResultError(first)).toBe(false);
  });

  it("authorizes a snapshotted ancestor after the ordinary spawner row is archived", async () => {
    const ownerSessionKey = "agent:worker:subagent:ordinary-owner";
    records.set("ordinary-owner", {
      runId: "ordinary-owner",
      childSessionKey: ownerSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "spawn collector",
      cleanup: "delete",
      createdAt: Date.now(),
      execution: { status: "running" },
    });
    const completed = collectorRun("nested", ownerSessionKey, { status: "done" });
    completed.swarmWaitOwnerSessionKeys = [ownerSessionKey, "agent:main:main"];
    records.set(completed.runId, completed);
    records.delete("ordinary-owner");
    const tool = createMainSessionWaitTool();

    const result = await tool.execute("call", { ids: ["nested"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "nested", status: "done" }],
      pending: [],
    });
  });

  it("keeps the public collector id after gateway run replacement", async () => {
    const remapped = collectorRun("gateway-run", "agent:main:main", { status: "done" });
    remapped.swarmRunId = "collector-run";
    records.set(remapped.runId, remapped);
    const tool = createMainSessionWaitTool();

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it.each(["tool", "bridge"] as const)(
    "rechecks a persisted %s completion after ownership changes at read settlement",
    async (boundary) => {
      const state = await vi.importActual<
        typeof import("../subagents/registry/subagent-registry-state.js")
      >("../subagents/registry/subagent-registry-state.js");
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          state.clearSubagentRunsReadCacheForTest();
          const entry = createSubagentRunRecord({
            ...collectorRun("persisted-owner-change", "agent:main:main", { status: "done" }),
            generation: 1,
            delivery: { status: "not_required" },
          });
          saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
          const replacement = createSubagentRunRecord({
            ...collectorRun(entry.runId, "agent:other:main", { status: "done" }),
            generation: 2,
            delivery: { status: "not_required" },
          });
          registryEvents.subscribe.mockImplementation(state.onSubagentRegistryPersisted);
          let publication: Promise<void> | undefined;
          registryEvents.read.mockImplementation(async (runIds) => {
            const prepared = await state.prepareSubagentRunsSnapshotForRunIds(new Map(), runIds);
            publication ??= Promise.resolve().then(() => {
              state.persistSubagentRunsToDiskOrThrow(new Map([[replacement.runId, replacement]]), [
                replacement.runId,
              ]);
            });
            void publication.catch(() => {});
            return prepared;
          });
          const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
          const abort = new AbortController();
          const waiting =
            boundary === "tool"
              ? createMainSessionWaitTool()
                  .execute("wait", { ids: [entry.runId], timeoutSeconds: 0 }, abort.signal)
                  .then((result) => result.details)
              : waitForCollectorCompletion({
                  runId: entry.runId,
                  currentSessionKeys: new Set(["agent:main:main"]),
                  currentAgentId: "main",
                  signal: abort.signal,
                });
          const observed = waiting.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          try {
            const result = await observed;
            await publication;
            expect(reads.mock.calls.some(([, command]) => command.type === "subagents.runs")).toBe(
              true,
            );
            expect(result).toEqual(
              boundary === "tool"
                ? {
                    value: {
                      completed: [],
                      pending: [],
                      errors: [{ runId: entry.runId, error: "not_owner" }],
                      success: false,
                    },
                  }
                : {
                    error: expect.objectContaining({
                      message: `agents.run not_owner: ${entry.runId}`,
                    }),
                  },
            );
          } finally {
            abort.abort();
            await Promise.allSettled([waiting, publication]);
            reads.mockRestore();
            state.clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );

  it("re-resolves a collector replaced while waiting", async () => {
    const pending = collectorRun("old-gateway-run", "agent:main:main");
    pending.swarmRunId = "collector-run";
    records.set(pending.runId, pending);
    const tool = createMainSessionWaitTool();
    setTimeout(() => {
      records.delete(pending.runId);
      const completed = collectorRun("new-gateway-run", "agent:main:main", { status: "done" });
      completed.swarmRunId = "collector-run";
      records.set(completed.runId, completed);
      for (const listener of registryEvents.listeners) {
        listener();
      }
    }, 5);

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 1 });
    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it.each([
    ["tool", "completed"],
    ["bridge", "completed"],
    ["tool", "foreign"],
    ["bridge", "foreign"],
  ] as const)(
    "coalesces publications during pending %s reads before returning a %s replacement",
    async (boundary, replacement) => {
      const runId = "collector-run";
      const previous = collectorRun("previous", "agent:main:main");
      previous.swarmRunId = runId;
      records.set(previous.runId, previous);
      const firstRead = createDeferred();
      const secondRead = createDeferred();
      const secondStarted = createDeferred();
      registryEvents.read
        .mockImplementationOnce(async (runIds) => {
          await firstRead.promise;
          return preparedRuns(() => selectRuns(runIds));
        })
        .mockImplementationOnce(async (runIds) => {
          secondStarted.resolve();
          await secondRead.promise;
          return preparedRuns(() => selectRuns(runIds));
        });
      const controller = new AbortController();
      const observed = waitAtBoundary(boundary, runId, controller.signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(registryEvents.listeners.size).toBe(1);
        for (let publication = 0; publication < 3; publication += 1) {
          for (const listener of registryEvents.listeners) {
            listener();
          }
        }
        expect(registryEvents.read).toHaveBeenCalledTimes(1);
        firstRead.resolve();
        await Promise.race([
          secondStarted.promise,
          observed.then(() => {
            throw new Error("Wait returned before checking the publication during its read.");
          }),
        ]);
        const current = collectorRun(
          "replacement",
          replacement === "foreign" ? "agent:other:main" : "agent:main:main",
          { status: "done" },
        );
        current.swarmRunId = runId;
        records.delete(previous.runId);
        records.set(current.runId, current);
        for (let publication = 0; publication < 3; publication += 1) {
          for (const listener of registryEvents.listeners) {
            listener();
          }
        }
        expect(registryEvents.read).toHaveBeenCalledTimes(2);
        secondRead.resolve();
        const result = await observed;
        if (replacement === "foreign") {
          expect(result).toEqual(
            boundary === "tool"
              ? {
                  value: {
                    completed: [],
                    pending: [],
                    errors: [{ runId, error: "not_owner" }],
                    success: false,
                  },
                }
              : { error: expect.objectContaining({ message: `agents.run not_owner: ${runId}` }) },
          );
        } else {
          const completed = {
            runId,
            result: "result-replacement",
            sessionKey: current.childSessionKey,
          };
          expect(result).toMatchObject({
            value: boundary === "tool" ? { completed: [completed], pending: [] } : completed,
          });
        }
        expect(registryEvents.read).toHaveBeenCalledTimes(2);
        expect(registryEvents.listeners.size).toBe(0);
      } finally {
        controller.abort();
        firstRead.resolve();
        secondRead.resolve();
        await observed;
      }
    },
  );

  it.each(["tool", "bridge"] as const)(
    "keeps a current %s completion after unrelated publications during its read",
    async (boundary) => {
      const entry = collectorRun("current-read", "agent:main:main", { status: "done" });
      const read = createDeferred();
      registryEvents.read.mockImplementationOnce(async () => {
        await read.promise;
        return preparedRuns(() => new Map([[entry.runId, entry]]));
      });
      const controller = new AbortController();
      const waiting = waitAtBoundary(boundary, entry.runId, controller.signal);
      try {
        for (const listener of registryEvents.listeners) {
          listener();
          listener();
        }
        read.resolve();
        expect(await waiting).toMatchObject(
          boundary === "tool"
            ? { completed: [{ runId: entry.runId }], pending: [] }
            : { runId: entry.runId },
        );
        expect(registryEvents.read).toHaveBeenCalledOnce();
        expect(registryEvents.listeners.size).toBe(0);
      } finally {
        controller.abort();
        read.resolve();
        await waiting.catch(() => {});
      }
    },
  );

  it("yields between immediate publication retries and returns current state at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setImmediate", "clearImmediate"] });
    const entry = collectorRun("publication-deadline", "agent:main:main");
    const checked = createDeferred();
    const entries = new Map([[entry.runId, entry]]);
    registryEvents.read
      .mockImplementationOnce(async () => ({
        consume(consume) {
          const value = consume(entries);
          for (const listener of registryEvents.listeners) {
            listener();
          }
          checked.resolve();
          return { ready: true, value };
        },
      }))
      .mockImplementationOnce(async () => preparedRuns(() => entries));
    const controller = new AbortController();
    const observed = createMainSessionWaitTool()
      .execute("deadline", { ids: [entry.runId], timeoutSeconds: 0.01 }, controller.signal)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await checked.promise;
      expect(registryEvents.read).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(10);
      expect(await observed).toMatchObject({
        value: { details: { completed: [], pending: [entry.runId] } },
      });
      expect(registryEvents.read).toHaveBeenCalledTimes(2);
      expect(registryEvents.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await vi.runAllTimersAsync();
      await observed;
      vi.useRealTimers();
    }
  });

  it("times out while unrelated persisted publications continue at read settlement", async () => {
    const state = await vi.importActual<
      typeof import("../subagents/registry/subagent-registry-state.js")
    >("../subagents/registry/subagent-registry-state.js");
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        state.clearSubagentRunsReadCacheForTest();
        const entry = createSubagentRunRecord({
          ...collectorRun("persisted-deadline", "agent:main:main"),
          delivery: { status: "not_required" },
        });
        const unrelated = createSubagentRunRecord({
          ...collectorRun("unrelated-publication", "agent:main:main"),
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([entry, unrelated].map((run) => [run.runId, run])));
        const unsubscribed = vi.fn();
        registryEvents.subscribe.mockImplementation((listener) => {
          const unsubscribe = state.onSubagentRegistryPersisted(listener);
          return () => {
            unsubscribe();
            unsubscribed();
          };
        });
        const overranDeadline = createDeferred();
        const releaseExtraRead = createDeferred();
        const abort = new AbortController();
        const publications: Promise<void>[] = [];
        let readCount = 0;
        let elapsed = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        registryEvents.read.mockImplementation(async (runIds) => {
          readCount += 1;
          if (readCount === 3) {
            // Observe starvation without waiting for the runner's timeout or stopping publications.
            overranDeadline.resolve();
            await releaseExtraRead.promise;
          }
          const prepared = await state.prepareSubagentRunsSnapshotForRunIds(new Map(), runIds);
          if (abort.signal.aborted) {
            return prepared;
          }
          const publication = Promise.resolve().then(() => {
            elapsed += 5;
            state.persistSubagentRunsToDiskOrThrow(
              new Map([[unrelated.runId, { ...unrelated, model: `publication-${elapsed}` }]]),
              [unrelated.runId],
            );
          });
          publications.push(publication);
          void publication.catch(() => abort.abort());
          return prepared;
        });
        const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        const waiting = createMainSessionWaitTool()
          .execute("deadline", { ids: [entry.runId], timeoutSeconds: 0.01 }, abort.signal)
          .then((result) => result.details);
        const observed = waiting.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          const result = await Promise.race([
            observed,
            overranDeadline.promise.then(() => ({ overranDeadline: true })),
          ]);
          expect(result).toEqual({ value: { completed: [], pending: [entry.runId] } });
          await Promise.all(publications);
          expect(publications).toHaveLength(2);
          expect(reads.mock.calls.some(([, command]) => command.type === "subagents.runs")).toBe(
            true,
          );
          expect(unsubscribed).toHaveBeenCalledOnce();
        } finally {
          abort.abort();
          releaseExtraRead.resolve();
          await Promise.allSettled([waiting, ...publications]);
          reads.mockRestore();
          clock.mockRestore();
          state.clearSubagentRunsReadCacheForTest();
        }
      },
    );
  });

  it.each([
    ["tool", "completion"],
    ["bridge", "completion"],
    ["tool", "failure"],
    ["bridge", "failure"],
  ] as const)("joins the %s read after abort wins its pending %s", async (boundary, outcome) => {
    const entry = collectorRun("pending-read", "agent:main:main", { status: "done" });
    const read = createDeferred<ReadonlyMap<string, SubagentRunRecord>>();
    const readFailure = new Error("worker read failed", {
      cause: new Error("reader cleanup failed"),
    });
    let readSettled = false;
    registryEvents.read.mockImplementationOnce(async () => {
      try {
        const entries = await read.promise;
        return preparedRuns(() => entries);
      } finally {
        readSettled = true;
      }
    });
    const controller = new AbortController();
    const observed = waitAtBoundary(boundary, entry.runId, controller.signal).then(
      (value) => ({ value, readSettled }),
      (error: unknown) => ({ error, readSettled }),
    );
    try {
      controller.abort();
      if (outcome === "failure") {
        read.reject(readFailure);
      } else {
        read.resolve(new Map([[entry.runId, entry]]));
      }
      expect(await observed).toMatchObject({
        error: {
          message: boundary === "tool" ? "agents_wait aborted." : "agents.run wait aborted.",
          ...(outcome === "failure" ? { cause: readFailure } : {}),
        },
        readSettled: true,
      });
      expect(registryEvents.read).toHaveBeenCalledOnce();
      expect(registryEvents.listeners.size).toBe(0);
    } finally {
      controller.abort();
      read.resolve(new Map());
      await observed;
    }
  });

  it.each(["tool", "bridge"] as const)(
    "rejects a foreign replacement while the %s is parked",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const pending = collectorRun("old-gateway-run", "agent:main:main");
      pending.swarmRunId = "collector-run";
      records.set(pending.runId, pending);
      const controller = new AbortController();
      const waiting = waitAtBoundary(boundary, "collector-run", controller.signal);
      const observed = waiting.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(registryEvents.listeners.size).toBe(1);
        records.delete(pending.runId);
        const foreign = collectorRun("new-gateway-run", "agent:other:main", { status: "done" });
        foreign.swarmRunId = "collector-run";
        foreign.completion = { required: false, resultText: "foreign result" };
        records.set(foreign.runId, foreign);
        for (const listener of registryEvents.listeners) {
          listener();
        }

        expect(await observed).toEqual(
          boundary === "tool"
            ? {
                value: {
                  completed: [],
                  pending: [],
                  errors: [{ runId: "collector-run", error: "not_owner" }],
                  success: false,
                },
              }
            : {
                error: expect.objectContaining({ message: "agents.run not_owner: collector-run" }),
              },
        );
        expect(registryEvents.listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        await observed;
        vi.useRealTimers();
      }
    },
  );

  it("does not treat a routed completion owner as the spawning session", async () => {
    const routed = collectorRun("routed", "agent:main:main", { status: "done" });
    routed.controllerSessionKey = "agent:worker:route-a";
    routed.swarmRequesterSessionKey = "agent:worker:route-a";
    records.set(routed.runId, routed);
    const routedOwner = createAgentsWaitTool({
      agentSessionKey: "agent:worker:route-a",
      agentId: "worker",
      config: { tools: { swarm: true } },
    });
    const completionOwner = createMainSessionWaitTool();

    const allowed = await routedOwner.execute("owner", { ids: ["routed"], timeoutSeconds: 0 });
    const denied = await completionOwner.execute("proxy", {
      ids: ["routed"],
      timeoutSeconds: 0,
    });

    expect(allowed.details).toMatchObject({ completed: [{ runId: "routed" }] });
    expect(denied.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "routed", error: "not_owner" }],
      success: false,
    });
    expect(isToolResultError(denied)).toBe(true);
  });

  it("rejects a foreign collector with the same bare requester key", async () => {
    const foreign = collectorRun("foreign-global", "global", { status: "done" });
    foreign.requesterAgentId = "ops";
    records.set(foreign.runId, foreign);
    const tool = createAgentsWaitTool({
      agentSessionKey: "global",
      agentId: "research",
      config: {
        agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
        tools: { swarm: true },
      },
    });

    const result = await tool.execute("wait", {
      ids: [foreign.runId],
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      errors: [{ runId: foreign.runId, error: "not_owner" }],
      success: false,
    });
  });

  it("marks entirely missing collector batches as failures without losing per-id errors", async () => {
    const tool = createMainSessionWaitTool();

    const result = await tool.execute("call", { ids: ["missing"], timeoutSeconds: 0 });

    expect(result.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "missing", error: "not_found" }],
      success: false,
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("rejects collector batches containing only blank run ids", async () => {
    const tool = createMainSessionWaitTool();

    await expect(tool.execute("call", { ids: [" ", "\t"], timeoutSeconds: 0 })).rejects.toThrow(
      "at least one non-empty run id",
    );
  });

  it.each(["before", "during", "registration"] as const)(
    "rejects when the wait is aborted %s collector waiting",
    async (abortTiming) => {
      records.set("pending", collectorRun("pending", "agent:main:main"));
      const tool = createMainSessionWaitTool();
      const controller = new AbortController();
      if (abortTiming === "before") {
        controller.abort();
      }
      if (abortTiming === "registration") {
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
          controller.abort();
          addEventListener(...args);
        });
      }

      const result = tool.execute(
        "call",
        { ids: ["pending"], timeoutSeconds: 1 },
        controller.signal,
      );
      if (abortTiming === "during") {
        controller.abort();
      }

      await expect(result).rejects.toMatchObject({
        name: "AbortError",
        message: "agents_wait aborted.",
      });
    },
  );

  it("rejects oversized wait batches before waiting", async () => {
    const tool = createMainSessionWaitTool();

    await expect(
      tool.execute("call", {
        ids: Array.from({ length: 1_001 }, (_, index) => `run-${index}`),
      }),
    ).rejects.toThrow("at most 1000 ids");
  });
});
