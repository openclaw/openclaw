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
import {
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
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

vi.mock("../subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) =>
      phase === "projection"
        ? actual.subscribeSubagentRunChanges(phase, listener)
        : registryEvents.subscribe(() =>
            listener({ runIds: undefined, sessionKeys: undefined }),
          )) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});

import { isToolResultError } from "../tool-result-error.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";
import {
  collectorRun,
  createMainSessionWaitTool,
  preparedRuns,
  selectRuns,
  waitAtBoundary,
} from "./agents-wait-tool.test-support.js";

// These read cases retain the actual publisher while the tool's subscription stays mocked.
function persistCollectorReadFixture(
  state: Pick<
    typeof import("../subagents/registry/subagent-registry-state.js"),
    "publishSubagentRunsAfterAtomicStore"
  >,
  rows: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
) {
  saveSubagentRegistryChangesToSqlite(rows, runIds);
  state.publishSubagentRunsAfterAtomicStore(rows, runIds)();
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
      .mockImplementation(async (runIds) => preparedRuns(() => selectRuns(records, runIds)));
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

  it.each([
    ["bridge", "before"],
    ["bridge", "registration"],
    ["tool", "before"],
    ["tool", "during"],
    ["tool", "registration"],
  ] as const)("rejects the %s when abort wins %s collector waiting", async (boundary, timing) => {
    const entry = collectorRun(
      "abort-race",
      "agent:main:main",
      boundary === "bridge" && timing === "before" ? { status: "done" } : undefined,
    );
    records.set(entry.runId, entry);
    const controller = new AbortController();
    if (timing === "before") {
      controller.abort();
    }
    if (timing === "registration") {
      const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
        controller.abort();
        originalAddEventListener(...args);
      });
    }

    const waiting =
      boundary === "bridge"
        ? waitForCollectorCompletion({
            runId: entry.runId,
            currentSessionKeys: new Set(["agent:main:main"]),
            signal: controller.signal,
          })
        : waitAtBoundary(boundary, entry.runId, controller.signal);
    if (timing === "during") {
      controller.abort();
    }
    if (boundary === "bridge") {
      await expect(waiting).rejects.toThrow("agents.run wait aborted");
    } else {
      await expect(waiting).rejects.toMatchObject({
        name: "AbortError",
        message: "agents_wait aborted.",
      });
    }
    expect(registryEvents.listeners.size).toBe(0);
  });

  it("parks without reading and resolves a replacement by its stable collector id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const runId = "collector-run";
    const entry = collectorRun("local-wake", "agent:main:main");
    entry.swarmRunId = runId;
    records.set(entry.runId, entry);
    const controller = new AbortController();
    const tool = createMainSessionWaitTool();
    const reads = vi.spyOn(records, "get");
    const initialRead = createDeferred();
    registryEvents.read.mockImplementationOnce(async (runIds) =>
      preparedRuns(() => {
        const selected = selectRuns(records, runIds);
        initialRead.resolve();
        return selected;
      }),
    );
    let result: unknown;
    const waiting = tool
      .execute("call", { ids: [runId], timeoutSeconds: 1 }, controller.signal)
      .then((value) => {
        result = value.details;
      });
    try {
      await initialRead.promise;
      const initialReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(750);
      expect(reads).toHaveBeenCalledTimes(initialReads);
      const replacement = collectorRun("replacement", "agent:main:main", { status: "done" });
      replacement.swarmRunId = runId;
      records.delete(entry.runId);
      records.set(replacement.runId, replacement);
      for (const listener of registryEvents.listeners) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({
        completed: [
          { runId, result: "result-replacement", sessionKey: replacement.childSessionKey },
        ],
        pending: [],
      });
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
          const registryPublication = await vi.importActual<
            typeof import("../subagents/registry/subagent-registry-publication.js")
          >("../subagents/registry/subagent-registry-publication.js");
          registryEvents.subscribe.mockImplementation((listener) =>
            registryPublication.subscribeSubagentRunChanges("persistence", listener),
          );
          let publication: Promise<void> | undefined;
          registryEvents.read.mockImplementation(async (runIds) => {
            const prepared = await state.prepareSubagentRunsSnapshotForRunIds(new Map(), runIds);
            publication ??= Promise.resolve().then(() => {
              persistCollectorReadFixture(state, new Map([[replacement.runId, replacement]]), [
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
          return preparedRuns(() => selectRuns(records, runIds));
        })
        .mockImplementationOnce(async (runIds) => {
          secondStarted.resolve();
          await secondRead.promise;
          return preparedRuns(() => selectRuns(records, runIds));
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
        const registryPublication = await vi.importActual<
          typeof import("../subagents/registry/subagent-registry-publication.js")
        >("../subagents/registry/subagent-registry-publication.js");
        registryEvents.subscribe.mockImplementation((listener) => {
          const unsubscribe = registryPublication.subscribeSubagentRunChanges(
            "persistence",
            listener,
          );
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
            persistCollectorReadFixture(
              state,
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

  it.each([
    { ids: [" ", "\t"], timeoutSeconds: 0, error: "at least one non-empty run id" },
    {
      ids: Array.from({ length: 1_001 }, (_, index) => `run-${index}`),
      error: "at most 1000 ids",
    },
  ])("rejects invalid batches: $error", async ({ error, ...params }) => {
    await expect(createMainSessionWaitTool().execute("call", params)).rejects.toThrow(error);
  });
});
