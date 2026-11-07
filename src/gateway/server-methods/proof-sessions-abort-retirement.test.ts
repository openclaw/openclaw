// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import * as controlSession from "../../agents/subagents/registry/subagent-control-session.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import * as registry from "../../agents/subagents/registry/subagent-registry.js";
import {
  removeSubagentSessionEntry,
  writeChildSession,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  abortContext,
  expectCancelledSession,
  expectStopResult,
  registerYieldedChild,
  seedYieldedSession,
  stopSession,
} from "./sessions.abort-lifecycle.test-support.js";

const fixture = useSubagentControlFixture();

const parentKey = "agent:main:dashboard:retirement-proof-parent";
const parentId = "retirement-proof-parent-session";
const parentRunId = "retirement-proof-parent-run";
const childKey = "agent:main:subagent:retirement-proof-child";
const childId = "retirement-proof-child-session";
const childRunId = "retirement-proof-child-run";
const inertChildKey = "agent:main:subagent:retirement-proof-inert-child";
const inertChildId = "retirement-proof-inert-child-session";
const inertChildRunId = "retirement-proof-inert-child-run";
const target = { agentId: "main", sessionKey: parentKey };
const parent = () => loadSessionEntry(target);
const child = () => subagentRuns.get(childRunId);

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
  // Only external requester delivery is unavailable; registry and persistence stay real.
  fixture.wake.mockResolvedValue(false);
  await writeChildSession(fixture.stateDir, childKey, childId, "original-incarnation");
  const startedAt = await seedYieldedSession(fixture.stateDir, parentKey, parentId, parentRunId);
  await registerYieldedChild({
    parentKey,
    parentRunId,
    childKey,
    childRunId,
    startedAt,
    sessionEntry: { sessionId: childId, lifecycleRevision: "original-incarnation" },
  });
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childKey,
    sessionId: childId,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Done" },
    },
  });
  await fixture.settle();
  expect(child()?.execution.outcome?.status).toBe("ok");
  expect(child()?.requesterSettleWake).toBeDefined();
});

it("skips removed-session preparation for an inert terminal keep child", async () => {
  await writeChildSession(fixture.stateDir, inertChildKey, inertChildId, "inert-incarnation");
  await registry.registerSubagentRun({
    runId: inertChildRunId,
    childSessionKey: inertChildKey,
    childAgentId: "main",
    sessionEntry: { sessionId: inertChildId, lifecycleRevision: "inert-incarnation" },
    controllerSessionKey: parentKey,
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterTurnRunId: parentRunId,
    requesterDisplayKey: parentKey,
    task: "Completed retained child",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  emitAgentEvent({
    runId: inertChildRunId,
    sessionKey: inertChildKey,
    sessionId: inertChildId,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Done" },
    },
  });
  await fixture.settle();
  await mutateSubagentRuns([inertChildRunId], (rows) => {
    const next = { ...rows.get(inertChildRunId)! };
    delete next.requesterSettleWake;
    return { value: undefined, postimages: new Map([[inertChildRunId, next]]) };
  });
  expect(subagentRuns.get(inertChildRunId)?.execution.status).toBe("terminal");
  expect(subagentRuns.get(inertChildRunId)?.requesterSettleWake).toBeUndefined();

  await removeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    sessionKey: inertChildKey,
    agentId: "main",
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: inertChildKey })).toBeUndefined();

  const prepareSession = vi.spyOn(controlSession, "prepareSubagentKillSession");
  const respond = vi.fn();
  await stopSession(parentKey, respond, abortContext(), { clearQueued: true });
  expectStopResult(respond);
  expect(prepareSession).toHaveBeenCalledOnce();
  await fixture.settle();
  expect(child()?.requesterSettleWake).toBeUndefined();
  expectCancelledSession(parent(), parentRunId);
  expect(subagentRuns.get(inertChildRunId)?.execution.status).toBe("terminal");
});
