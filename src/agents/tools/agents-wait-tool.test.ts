import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { typeCheckSources } from "../../../test/helpers/typescript.js";
import { projectAgentHistoryActivity } from "../../infra/agent-activity-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import {
  createNestedToolActivity,
  readNestedToolActivity,
} from "../../sessions/nested-tool-activity.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { applyCodeModeCatalog, buildCodeModeCatalogPrompt } from "../code-mode.js";
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

const MAIN = "agent:main:main";
type RegistryState = typeof import("../subagents/registry/subagent-registry-state.js");
const records = new Map<string, SubagentRunRecord>();
type ReadRuns = (runIds: readonly string[]) => Promise<PreparedSubagentRunsRead>;
const registryEvents = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  read: vi.fn<ReadRuns>(),
  subscribe: vi.fn<(listener: () => void) => () => void>(),
}));

// mock-isolation: Collector persistence is external I/O; the real controller owns recovery.
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
  observe,
  preparedRuns,
  startParentWait,
  selectRuns,
  waitAtBoundary,
} from "./agents-wait-tool.test-support.js";

// These read cases retain the actual publisher while the tool's subscription stays mocked.
function persistCollectorReadFixture(
  state: Pick<RegistryState, "publishSubagentRunsAfterAtomicStore">,
  entry: SubagentRunRecord,
) {
  const rows = new Map([[entry.runId, entry]]);
  const runIds = [entry.runId];
  saveSubagentRegistryChangesToSqlite(rows, runIds);
  state.publishSubagentRunsAfterAtomicStore(rows, runIds)();
}

function storedRun(entry: SubagentRunRecord) {
  return createSubagentRunRecord({ ...entry, delivery: { status: "not_required" } });
}

function addRun(
  runId: string,
  completion?: SubagentRunRecord["collectorCompletion"],
  overrides: Partial<SubagentRunRecord> = {},
  owner = MAIN,
) {
  const entry = { ...collectorRun(runId, owner, completion), ...overrides };
  records.set(runId, entry);
  return entry;
}

function startWait(runId: string, timeoutSeconds = 1, boundary: "tool" | "bridge" = "tool") {
  const controller = new AbortController();
  const state: { result?: unknown } = {};
  const waiting = (
    boundary === "tool"
      ? createMainSessionWaitTool()
          .execute("wait", { ids: [runId], timeoutSeconds }, controller.signal)
          .then((value) => value.details)
      : waitAtBoundary(boundary, runId, controller.signal)
  ).then((value) => {
    state.result = value;
    return value;
  });
  const observed = observe(waiting);
  onTestFinished(async () => {
    controller.abort();
    await observed;
    vi.useRealTimers();
  });
  return { observed, state };
}

async function withPersistedState(exercise: (state: RegistryState) => Promise<void>) {
  const state = await vi.importActual<RegistryState>(
    "../subagents/registry/subagent-registry-state.js",
  );
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      state.clearSubagentRunsReadCacheForTest();
      try {
        await exercise(state);
      } finally {
        state.clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

async function subscribePersisted() {
  const publication = await vi.importActual<
    typeof import("../subagents/registry/subagent-registry-publication.js")
  >("../subagents/registry/subagent-registry-publication.js");
  const unsubscribed = vi.fn();
  registryEvents.subscribe.mockImplementation((listener) => {
    const unsubscribe = publication.subscribeSubagentRunChanges("persistence", listener);
    return () => {
      unsubscribe();
      unsubscribed();
    };
  });
  return unsubscribed;
}

function executeWait(
  ids: string[],
  timeoutSeconds = 0,
  signal?: AbortSignal,
  tool = createMainSessionWaitTool(),
) {
  return tool.execute("wait", { ids, timeoutSeconds }, signal);
}

function publishChanges(count = 1) {
  for (let publication = 0; publication < count; publication++) {
    for (const listener of registryEvents.listeners) {
      listener();
    }
  }
}

function notOwner(runId: string) {
  return { completed: [], pending: [], errors: [{ runId, error: "not_owner" }], success: false };
}

function deniedAtBoundary(boundary: "tool" | "bridge", runId: string) {
  return boundary === "tool"
    ? { value: notOwner(runId) }
    : { error: expect.objectContaining({ message: `agents.run not_owner: ${runId}` }) };
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
    addRun("ready", {
      status: "done",
      structured: { answer: 42 },
    });
    const h = createCodeModeHarness();
    const tool = createMainSessionWaitTool();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const execTool = expectDefined(h.tools[0], "Code Mode exec");
    const waitTool = expectDefined(h.tools[1], "Code Mode wait");
    expect(buildCodeModeCatalogPrompt(h.ctx, h.catalogRef.current!.entries)).toContain(
      "completed: Array<",
    );
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
      MAIN,
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

    const waiting = waitAtBoundary(boundary, entry.runId, controller.signal);
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

  it.each([
    ["tool", false],
    ["tool", true],
    ["bridge", true],
  ] as const)(
    "parks without polling and handles a %s replacement (foreign=%s)",
    async (boundary, foreign) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const runId = "collector-run";
      const entry = addRun("previous", undefined, { swarmRunId: runId });
      const reads = vi.spyOn(records, "get");
      const initialRead = createDeferred();
      registryEvents.read.mockImplementationOnce(async (runIds) =>
        preparedRuns(() => {
          const selected = selectRuns(records, runIds);
          initialRead.resolve();
          return selected;
        }),
      );
      const wait = startWait(runId, 1, boundary);
      onTestFinished(() => reads.mockRestore());
      expect(registryEvents.listeners.size).toBe(1);
      await initialRead.promise;
      const initialReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(750);
      expect(reads).toHaveBeenCalledTimes(initialReads);
      records.delete(entry.runId);
      const replacement = addRun(
        "replacement",
        { status: "done" },
        { swarmRunId: runId },
        foreign ? "agent:other:main" : MAIN,
      );
      publishChanges();
      await vi.advanceTimersByTimeAsync(0);
      if (foreign) {
        expect(await wait.observed).toEqual(deniedAtBoundary(boundary, runId));
      } else {
        expect(wait.state.result).toMatchObject({
          completed: [
            { runId, result: "result-replacement", sessionKey: replacement.childSessionKey },
          ],
          pending: [],
        });
      }
      expect(registryEvents.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("projects an authorized collector failure without failing a mixed batch", async () => {
    const failed = addRun("failed", {
      status: "failed",
      structured: { partial: true },
    });
    failed.execution = {
      status: "terminal",
      startedAt: 100,
      endedAt: 175,
      outcome: { status: "error", error: "provider failed after tool output" },
    };
    failed.completion = { required: false, resultText: null, capturedAt: 10 };
    addRun("pending");
    const result = await executeWait([failed.runId, "pending"]);

    expect(result.details).toEqual({
      completed: [
        {
          runId: failed.runId,
          status: "failed",
          result: "",
          structured: { partial: true },
          error: "provider failed after tool output",
          sessionKey: failed.childSessionKey,
          groupId: "group",
          runtimeMs: 75,
        },
      ],
      pending: ["pending"],
    });
    expect(isToolResultError(result)).toBe(false);
    const activity = createNestedToolActivity({
      runId: "owning-parent-run",
      scopeId: "code-mode-scope",
      afterEntryId: null,
      startOrder: 0,
      toolCallId: "wait-call",
      toolName: "agents_wait",
      input: { ids: ["failed", "pending"] },
      result,
      isError: false,
      startedAt: 1,
      timestamp: 2,
    });
    records.clear();
    const persisted = JSON.stringify(activity);
    const history = projectAgentHistoryActivity([
      { messageId: "persisted-wait", message: JSON.parse(persisted) },
    ]);
    expect(history[0]?.items[0]).toMatchObject({ name: "agents_wait", status: "completed" });
    expect(readNestedToolActivity(JSON.parse(persisted))?.details.result.details).toMatchObject({
      completed: [
        {
          runId: "failed",
          sessionKey: "agent:worker:subagent:failed",
          runtimeMs: 75,
          status: "failed",
          error: "provider failed after tool output",
        },
      ],
      pending: ["pending"],
    });
  });

  it.each([-60_000, 60_000])(
    "keeps its elapsed deadline after a %d ms clock step",
    async (step) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(100_000);
      addRun("clock-step");
      const wait = startWait("clock-step", 0.1);
      await vi.advanceTimersByTimeAsync(25);
      vi.setSystemTime(Date.now() + step);
      await vi.advanceTimersByTimeAsync(74);
      expect(wait.state.result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(wait.state.result).toEqual({ completed: [], pending: ["clock-step"] });
    },
  );

  it("orders completions by durable capture time with input-order ties", async () => {
    for (const [id, capturedAt] of [
      ["later", 10],
      ["earlier", 5],
      ["tied", 5],
    ] as const) {
      addRun(
        id,
        { status: "done" },
        { completion: { required: false, resultText: id, capturedAt } },
      );
    }
    addRun("foreign", { status: "done" }, {}, "agent:other:main");
    addRun("pending-one");
    addRun("pending-two");
    const tool = createMainSessionWaitTool();
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
    done.swarmWaitOwnerSessionKeys = ["agent:worker:subagent:owner", MAIN];
    records.set("done", done);
    records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "failed" }));
    const tool = createAgentsWaitTool({
      agentSessionKey: MAIN,
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
      await withPersistedState(async (state) => {
        const entry = storedRun({
          ...collectorRun("persisted-owner-change", MAIN, { status: "done" }),
          generation: 1,
        });
        saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
        const replacement = storedRun({
          ...collectorRun(entry.runId, "agent:other:main", { status: "done" }),
          generation: 2,
        });
        await subscribePersisted();
        let publication: Promise<void> | undefined;
        registryEvents.read.mockImplementation(async (runIds) => {
          const prepared = await state.prepareSubagentRunsSnapshotForRunIds(new Map(), runIds);
          publication ??= Promise.resolve().then(() => {
            persistCollectorReadFixture(state, replacement);
          });
          void publication.catch(() => {});
          return prepared;
        });
        const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        const abort = new AbortController();
        const waiting =
          boundary === "tool"
            ? executeWait([entry.runId], 0, abort.signal).then((result) => result.details)
            : waitForCollectorCompletion({
                runId: entry.runId,
                currentSessionKeys: new Set([MAIN]),
                currentAgentId: "main",
                signal: abort.signal,
              });
        const observed = observe(waiting);
        try {
          const result = await observed;
          await publication;
          expect(reads.mock.calls.some(([, command]) => command.type === "subagents.runs")).toBe(
            true,
          );
          expect(result).toEqual(deniedAtBoundary(boundary, entry.runId));
        } finally {
          abort.abort();
          await Promise.allSettled([waiting, publication]);
          reads.mockRestore();
        }
      });
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
      const previous = addRun("previous", undefined, { swarmRunId: runId });
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
      const observed = observe(waitAtBoundary(boundary, runId, controller.signal));
      try {
        expect(registryEvents.listeners.size).toBe(1);
        publishChanges(3);
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
          replacement === "foreign" ? "agent:other:main" : MAIN,
          { status: "done" },
        );
        current.swarmRunId = runId;
        records.delete(previous.runId);
        records.set(current.runId, current);
        publishChanges(3);
        expect(registryEvents.read).toHaveBeenCalledTimes(2);
        secondRead.resolve();
        const result = await observed;
        if (replacement === "foreign") {
          expect(result).toEqual(deniedAtBoundary(boundary, runId));
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
    const entry = collectorRun("publication-deadline", MAIN);
    const checked = createDeferred();
    const entries = new Map([[entry.runId, entry]]);
    registryEvents.read
      .mockImplementationOnce(async () => ({
        consume(consume) {
          const value = consume(entries);
          publishChanges();
          checked.resolve();
          return { ready: true, value };
        },
      }))
      .mockImplementationOnce(async () => preparedRuns(() => entries));
    const controller = new AbortController();
    const observed = executeWait([entry.runId], 0.01, controller.signal).then(
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
    await withPersistedState(async (state) => {
      const entry = storedRun(collectorRun("persisted-deadline", MAIN));
      const unrelated = storedRun(collectorRun("unrelated-publication", MAIN));
      saveSubagentRegistryToSqlite(new Map([entry, unrelated].map((run) => [run.runId, run])));
      const unsubscribed = await subscribePersisted();
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
          persistCollectorReadFixture(state, { ...unrelated, model: `publication-${elapsed}` });
        });
        publications.push(publication);
        void publication.catch(() => abort.abort());
        return prepared;
      });
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const waiting = executeWait([entry.runId], 0.01, abort.signal).then(
        (result) => result.details,
      );
      const observed = observe(waiting);
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
      }
    });
  });

  it.each([
    ["tool", "completion"],
    ["bridge", "completion"],
    ["tool", "failure"],
    ["bridge", "failure"],
  ] as const)("joins the %s read after abort wins its pending %s", async (boundary, outcome) => {
    const entry = collectorRun("pending-read", MAIN, { status: "done" });
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

  it("does not treat a routed completion owner as the spawning session", async () => {
    addRun(
      "routed",
      { status: "done" },
      {
        controllerSessionKey: "agent:worker:route-a",
        swarmRequesterSessionKey: "agent:worker:route-a",
      },
    );
    const routedOwner = createAgentsWaitTool({
      agentSessionKey: "agent:worker:route-a",
      agentId: "worker",
      config: { tools: { swarm: true } },
    });
    const completionOwner = createMainSessionWaitTool();

    const allowed = await routedOwner.execute("owner", { ids: ["routed"], timeoutSeconds: 0 });
    const denied = await executeWait(["routed"], 0, undefined, completionOwner);

    expect(allowed.details).toMatchObject({ completed: [{ runId: "routed" }] });
    expect(denied.details).toEqual(notOwner("routed"));
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

    const result = await executeWait([foreign.runId], 0, undefined, tool);

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
    { timeoutSeconds: 0, error: "array of run id strings" },
    { ids: [7], timeoutSeconds: 0, error: "array of run id strings" },
    { ids: "missing", timeoutSeconds: 0, error: "array of run id strings" },
    { ids: 7, timeoutSeconds: 0, error: "array of run id strings" },
    {
      ids: Array.from({ length: 1_001 }, (_, index) => `run-${index}`),
      error: "at most 1000 ids",
    },
  ])("rejects invalid batches: $error", async ({ error, ...params }) => {
    await expect(createMainSessionWaitTool().execute("call", params)).rejects.toThrow(error);
  });

  function observeRead() {
    const read = createDeferred();
    registryEvents.read.mockImplementation(async (ids) => {
      read.resolve();
      return preparedRuns(() => selectRuns(records, ids));
    });
    return read.promise;
  }

  it.each(["cell", "nested"])(
    "keeps sibling results owned with %s awaitResults until every completion arrives",
    async (mode) => {
      onTestFinished(resetCodeModeTestState);
      const first = addRun("first-required", { status: "done" });
      const second = addRun("second-required");
      const read = observeRead();
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createMainSessionWaitTool()] });
      const result = expectDefined(h.tools[0], "exec").execute("required-child-results", {
        title: "Collect required child results",
        awaitResults: mode === "cell",
        code: `return await agents_wait({ids:["first-required", "second-required"]${mode === "nested" ? ", awaitResults: true" : ""}});`,
      });
      const complete = () => {
        second.collectorCompletion = { status: "failed" };
        publishChanges();
      };
      try {
        await read;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await vi.advanceTimersByTimeAsync(60_000);
        const pending = Symbol("pending");
        expect(await Promise.race([result, Promise.resolve(pending)])).toBe(pending);
        expect(registryEvents.read).toHaveBeenCalledOnce();
        second.completion = { required: false, resultText: "child failure evidence" };
        complete();
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
        complete();
        await result;
      }
    },
  );

  it("cancels required collection without borrowing another requester's child", async () => {
    const entry = addRun("foreign-required", undefined, {}, "agent:other:main");
    const tool = createMainSessionWaitTool();
    await expect(
      tool.execute("foreign", { ids: [entry.runId], awaitResults: true }),
    ).resolves.toMatchObject({
      details: { success: false, errors: [{ runId: entry.runId, error: "not_owner" }] },
    });
    entry.swarmRequesterSessionKey = MAIN;
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

  it.each([
    { outcome: "done", codeMode: true },
    { outcome: "failed", codeMode: false },
    { outcome: "stopped", codeMode: false },
  ] as const)(
    "keeps a long collector wait alive until $outcome (Code Mode: $codeMode)",
    async ({ outcome, codeMode }) => {
      const parent = await startParentWait({ records, read: registryEvents.read, codeMode });
      await parent.read;
      parent.advancePastQuietToolDeadline();
      await expect(
        recoverStuckDiagnosticSession({
          operation: parent.operation,
          sessionId: parent.operation.sessionId,
          sessionKey: parent.operation.key,
          ageMs: 16 * 60_000,
          queueDepth: 0,
          allowActiveAbort: true,
        }),
      ).resolves.toMatchObject({ status: "skipped", reason: "active_reply_work" });
      expect(parent.abort).not.toHaveBeenCalled();
      expect(registryEvents.read).toHaveBeenCalledOnce();

      if (outcome === "stopped") {
        const stopped = stopSession({
          capture: captureSessionControllerStop({ operations: [parent.operation] }),
          source: "client-run",
        });
        expect(stopped.aborted).toBe(true);
        await expect(parent.result).rejects.toThrow("agents_wait aborted");
        expect(parent.abort).toHaveBeenCalledOnce();
      } else {
        parent.entry.collectorCompletion = { status: outcome };
        parent.entry.completion = { required: false, resultText: "collected result" };
        publishChanges();
        const completed = {
          completed: [{ runId: parent.entry.runId, status: outcome, result: "collected result" }],
          pending: [],
        };
        await expect(parent.result).resolves.toMatchObject({
          details: codeMode ? { status: "completed", value: completed } : completed,
        });
      }
      expect(parent.operation.watchdog.snapshot().waits).toEqual([]);
      expect(registryEvents.listeners.size).toBe(0);
    },
  );

  it.each(["execution deadline", "revoked authority", "stalled reread"] as const)(
    "does not protect a collector after %s",
    async (cause) => {
      const parent = await startParentWait({ records, read: registryEvents.read });
      await parent.read;
      parent.advancePastQuietToolDeadline();
      expect(await parent.operation.watchdog.tick()).toEqual({
        action: "observe",
        reason: "runtime_owned",
      });
      const reread = createDeferred<PreparedSubagentRunsRead>();
      try {
        if (cause === "execution deadline") {
          parent.attempt.setExecutionDeadline(Date.now());
        } else if (cause === "revoked authority") {
          parent.admission.close();
        } else {
          registryEvents.read.mockImplementation(() => reread.promise);
          publishChanges();
        }
        expect(parent.operation.watchdog.decide()).toMatchObject({
          action: "stop",
          reason: cause === "execution deadline" ? "execution_deadline" : "semantic_stall",
        });
        await parent.operation.watchdog.tick();
        expect(parent.abort).toHaveBeenCalledOnce();
        expect(parent.operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
      } finally {
        reread.resolve(preparedRuns(() => selectRuns(records, [parent.entry.runId])));
      }
      await expect(parent.result).rejects.toThrow("agents_wait aborted");
      expect(parent.operation.watchdog.snapshot().waits).toEqual([]);
      expect(registryEvents.listeners.size).toBe(0);
    },
  );
});
