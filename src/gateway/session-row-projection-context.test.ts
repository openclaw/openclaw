import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";

const contexts: ReturnType<typeof createSessionRowProjectionContext>[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.dispose?.();
  }
  resetAgentRunRegistryForTest();
  subagentRuns.clear();
  vi.restoreAllMocks();
});

const child = "agent:main:child";
const parent = "agent:main:parent";
const runContext = {
  agentId: "main",
  sessionKey: child,
  sessionId: "child",
  projectSessionActive: true,
};
const subagent = (runId: string) =>
  createSubagentRunRecord({ runId, childSessionKey: child, requesterSessionKey: parent });
const noop = () => {};

function fixture() {
  const context = createSessionRowProjectionContext(
    createSubagentSessionListReadView({ env: process.env }),
  );
  contexts.push(context);
  const prepare = (epoch: number) =>
    context.prepare(
      epoch,
      {},
      () => [],
      noop,
      () => undefined,
    );
  prepare(0);
  return { context, prepare };
}

it("retains active-run facts through unrelated row epochs without sharing independent indexes", () => {
  registerAgentRunContext("run", runContext);
  subagentRuns.set("subagent", subagent("subagent"));
  const { context, prepare } = fixture();
  const initial = context.current;
  registerAgentRunContext("run", { lastActiveAt: Date.now(), projectSessionMessages: false });
  for (let epoch = 1; epoch <= 8; epoch++) {
    context.invalidate({ sessionKey: "agent:main:unrelated" });
    prepare(epoch);
    expect(context.current.projectedAgentRuns).toBe(initial.projectedAgentRuns);
    expect(context.current.projectedSubagentActivity).toBe(initial.projectedSubagentActivity);
    expect(context.current.subagentRuns).not.toBe(initial.subagentRuns);
  }
  expect([...context.current.projectedSubagentActivity!]).toEqual([parent]);
  const independent = fixture().context.current.projectedAgentRuns!;
  expect(independent).toEqual(initial.projectedAgentRuns);
  expect(independent.sessionKeys).not.toBe(initial.projectedAgentRuns!.sessionKeys);
  registerAgentRunContext("run", { isControlUiVisible: false });
  expect(context.readPrepared(8)).toBeUndefined();
  prepare(8);
  expect(context.current.projectedAgentRuns?.modelsBySessionId.size).toBe(0);
  registerAgentRunContext("run", { projectSessionActive: false });
  prepare(8);
  expect([...context.current.projectedSubagentActivity!]).toEqual([]);
});

it("refreshes time-sensitive subagent reads while retaining unchanged ancestor membership", () => {
  const startedAt = 1_800_000_000_000;
  using clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 1_000);
  const run = createSubagentRunRecord({
    runId: "retained",
    childSessionKey: child,
    requesterSessionKey: parent,
    createdAt: startedAt,
    startedAt,
  });
  vi.spyOn(registryRead, "buildSubagentSessionListReadIndex").mockImplementation((now) =>
    buildSubagentRunReadIndexFromRuns({ runs: new Map([[run.runId, run]]), now }),
  );
  const { context, prepare } = fixture();
  const initial = context.current;
  expect(initial.subagentRuns.countActiveDescendantRuns(parent)).toBe(1);
  clock.mockReturnValue(startedAt + 2 * 60 * 60_000 + 1);
  prepare(1);
  expect(context.current.subagentRuns.countActiveDescendantRuns(parent)).toBe(0);
  expect(context.current.projectedSubagentActivity).toBe(initial.projectedSubagentActivity);
});

it("patches list facts after keyed publications without rebuilding for progress-only updates", () => {
  let run = subagent("changed");
  subagentRuns.set(run.runId, run);
  const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
  const { context, prepare } = fixture();
  const initialRevision = context.materializedRevisions.subagentRevision;
  const initialRun = run;
  for (let update = 0; update < 100; update++) {
    run = {
      ...initialRun,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        progressOperationId: `progress-${update}`,
      },
    };
    subagentRuns.set(run.runId, run);
    subagentRuns.commitOwnership(run);
    prepare(update + 1);
  }
  expect(context.materializedRevisions.subagentRevision).toBe(initialRevision);
  expect(builds).toHaveBeenCalledTimes(1);
  expect(context.current.subagentRuns.countActiveDescendantRuns(parent)).toBe(1);

  run = {
    ...run,
    execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
  };
  subagentRuns.set(run.runId, run);
  subagentRuns.commitOwnership(run);
  prepare(101);
  expect(context.current.subagentRuns.getDisplaySubagentRun(child)?.execution.status).toBe(
    "terminal",
  );
  expect(context.current.subagentRuns.countActiveDescendantRuns(parent)).toBe(0);
  expect(context.materializedRevisions.subagentRevision).toBe(initialRevision + 1);
  expect(builds).toHaveBeenCalledTimes(1);

  subagentRuns.delete(run.runId);
  subagentRuns.confirmRetirement(run);
  prepare(102);
  expect(context.current.subagentRuns.getDisplaySubagentRun(child)).toBeNull();
  expect(context.current.subagentRuns.runsByControllerSessionKey.has(parent)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(1);

  subagentRuns.clear();
  prepare(103);
  expect(builds).toHaveBeenCalledTimes(2);
});
