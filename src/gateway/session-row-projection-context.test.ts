import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  buildProjectedAgentRunIndex,
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  recordAgentRunModel,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  sweepStaleRunContexts,
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
      () => {},
      () => undefined,
    );
  prepare(0);
  return { context, prepare };
}

it("retains active-run facts through unrelated row epochs without sharing independent indexes", () => {
  registerAgentRunContext("run", runContext);
  subagentRuns.set(
    "subagent",
    createSubagentRunRecord({
      runId: "subagent",
      childSessionKey: child,
      requesterSessionKey: parent,
    }),
  );
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
  const fresh = buildProjectedAgentRunIndex();
  expect(independent).toEqual(initial.projectedAgentRuns);
  expect(independent.sessionKeys).not.toBe(initial.projectedAgentRuns!.sessionKeys);
  expect(fresh.sessionKeys).not.toBe(initial.projectedAgentRuns!.sessionKeys);
});

it("refreshes both run and ancestor facts at the same epoch after owner publications", () => {
  registerAgentRunContext("run", runContext);
  const subagent = createSubagentRunRecord({
    runId: "subagent",
    childSessionKey: child,
    requesterSessionKey: parent,
  });
  subagentRuns.set(subagent.runId, subagent);
  const { context, prepare } = fixture();
  const current = () => {
    expect(context.readPrepared(0)).toBeUndefined();
    prepare(0);
    expect(context.readPrepared(0)).toBe(context.current);
    expect(context.current.projectedAgentRuns).toEqual(buildProjectedAgentRunIndex());
    return context.current;
  };
  recordAgentRunModel("run", { provider: "openai", model: "model-a" });
  expect(current().projectedAgentRuns?.modelsBySessionId.get("main\0child")).toEqual({
    provider: "openai",
    model: "model-a",
  });
  recordAgentRunModel("run", undefined);
  expect(current().projectedAgentRuns?.modelsBySessionId.get("main\0child")).toBeNull();
  registerAgentRunContext("run", { isControlUiVisible: false });
  expect(current().projectedAgentRuns?.modelsBySessionId.size).toBe(0);
  registerAgentRunContext("run", { isControlUiVisible: true });
  current();
  registerAgentRunContext("run", {
    agentId: "other",
    sessionKey: "agent:other:moved",
    sessionId: "moved",
  });
  expect([...current().projectedAgentRuns!.sessionKeys.keys()]).toEqual([
    "other\0agent:other:moved",
  ]);
  registerAgentRunContext("run", runContext);
  current();
  const releaseWait = registerAgentRunCapacityWait("run", getAgentRunLifecycleGeneration())!;
  expect(current().projectedAgentRuns?.sessionKeys.get(`main\0${child}`)).toBe("queued");
  releaseWait();
  expect(current().projectedAgentRuns?.sessionKeys.get(`main\0${child}`)).toBe("running");
  const runsBeforeMove = context.current.projectedAgentRuns;
  subagentRuns.set(subagent.runId, { ...subagent, requesterSessionKey: "agent:main:next" });
  publishSubagentRunChanges([child]);
  expect([...current().projectedSubagentActivity!]).toEqual(["agent:main:next"]);
  expect(context.current.projectedAgentRuns).toBe(runsBeforeMove);
  registerAgentRunContext("run", { projectSessionActive: false });
  expect([...current().projectedSubagentActivity!]).toEqual([]);
  registerAgentRunContext("run", runContext);
  current();
  const claim = claimAgentRunContext("run", runContext, { trackOwner: true, ownsContext: true });
  current();
  clearAgentRunContext("run");
  current();
  releaseAgentRunContext("run", claim);
  expect(current().projectedAgentRuns?.sessionKeys.size).toBe(0);
  registerAgentRunContext("run", runContext);
  current();
  rotateAgentRunRegistryLifecycleGeneration();
  expect(current().projectedAgentRuns?.sessionKeys.size).toBe(0);
  registerAgentRunContext("fresh", { ...runContext, registeredAt: 1 });
  current();
  sweepStaleRunContexts(0);
  expect(current().projectedAgentRuns?.sessionKeys.size).toBe(0);
  registerAgentRunContext("fresh", runContext);
  current();
  resetAgentRunRegistryForTest();
  expect(current().projectedAgentRuns?.sessionKeys.size).toBe(0);
});

it("keeps current facts after rejected registration and stale queue release", () => {
  const claim = claimAgentRunContext("run", runContext, { trackOwner: true, exclusive: true });
  const releaseWait = registerAgentRunCapacityWait("run", getAgentRunLifecycleGeneration())!;
  const { context, prepare } = fixture();
  registerAgentRunContext("run", {
    sessionKey: "agent:other:rejected",
    projectSessionActive: false,
  });
  expect(context.readPrepared(0)).toBe(context.current);
  const initial = context.current.projectedAgentRuns;
  prepare(1);
  expect(context.current.projectedAgentRuns).toBe(initial);
  releaseAgentRunContext("run", claim);
  registerAgentRunContext("run", runContext);
  prepare(2);
  const replacement = context.current.projectedAgentRuns;
  releaseWait();
  expect(context.readPrepared(2)).toBe(context.current);
  prepare(3);
  expect(context.current.projectedAgentRuns).toBe(replacement);
  expect(replacement?.sessionKeys.get(`main\0${child}`)).toBe("running");
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
  const run = createSubagentRunRecord({
    runId: "changed",
    childSessionKey: child,
    requesterSessionKey: parent,
  });
  subagentRuns.set(run.runId, run);
  const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
  const { context, prepare } = fixture();
  const initialRevision = context.materializedRevisions.subagentRevision;
  for (let update = 0; update < 100; update++) {
    run.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      progressOperationId: `progress-${update}`,
    };
    subagentRuns.commitOwnership(run);
    prepare(update + 1);
  }
  expect(context.materializedRevisions.subagentRevision).toBe(initialRevision);
  expect(builds).toHaveBeenCalledTimes(1);
  expect(context.current.subagentRuns.countActiveDescendantRuns(parent)).toBe(1);

  run.execution = { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } };
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
