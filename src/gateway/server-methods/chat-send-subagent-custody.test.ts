import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { isMainRestartRecoveryCandidate } from "../../config/sessions/restart-recovery-state.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { loadRealChatDispatch } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

const runtime = vi.hoisted(() => ({ run: vi.fn<typeof runEmbeddedAgentEntry>() }));
// mock-isolation: Fix backend I/O while exercising real chat admission and native custody.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runtime.run,
}));
// mock-isolation: Retained native task waits must never connect to a running Gateway.
vi.mock("../call.js", () => ({
  callGateway: vi.fn(async () => await new Promise<never>(() => {})),
}));

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("retains native child custody before a human continuation executes", async ({ signal }) => {
  const sessionKey = "agent:main:dashboard:retained-child";
  await using fixture = await createFixture({ active: false, preserveContent: true, sessionKey });
  const runId = "human-child-continuation";
  const task = "Verify the retained result.";
  const entry = {
    sessionId: fixture.scope.sessionId,
    lifecycleRevision: "retained-child-revision",
    updatedAt: Date.now(),
    status: "done" as const,
    spawnedBy: "agent:main:main",
    parentSessionKey: "agent:main:main",
    spawnDepth: 1,
    subagentRole: "leaf" as const,
  };
  Object.assign(fixture.params, { message: task, idempotencyKey: runId });
  await upsertSessionEntryCore(fixture.scope, entry);
  const completed = createSubagentRunRecord({
    runId: "completed-child",
    childSessionKey: sessionKey,
    childAgentId: "main",
    childSessionIdentity: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    },
    requesterAgentId: "main",
    task: "Original completed task",
    expectsCompletionMessage: false,
    startedAt: 1,
    endedAt: 2,
    outcome: { status: "ok" },
  });
  await mutateSubagentRuns([completed.runId], () => ({
    value: undefined,
    postimages: new Map([[completed.runId, completed]]),
  }));
  const entered = createDeferred();
  const release = createDeferred();
  runtime.run.mockImplementation(async (params) => {
    entered.resolve();
    await withinTest(release.promise, signal);
    return {
      outcome: "completed",
      result: { payloads: [{ text: "Retained result verified." }], meta: { durationMs: 0 } },
      provider: params.selection.provider,
      model: params.selection.model,
      attempts: [],
      terminal: { outcome: { status: "ok", reason: "completed" }, metadata: {} },
      settleSessionOverride: async () => {},
    };
  });
  dispatchInboundMessageMock.mockImplementation(await loadRealChatDispatch());
  try {
    const ack = await fixture.send();
    expect(ack).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "started" }),
      undefined,
      expect.anything(),
    );
    await withinTest(entered.promise, signal);
    expect([subagentRuns.get(runId), subagentRuns.get(completed.runId)]).toMatchObject([
      { runId, childSessionKey: sessionKey, task, execution: { status: "running" } },
      {
        task: "Original completed task",
        execution: { status: "terminal", outcome: { status: "ok" } },
      },
    ]);
    expect(isMainRestartRecoveryCandidate(loadSessionEntry(fixture.scope)!, sessionKey)).toBe(
      false,
    );
  } finally {
    release.resolve();
  }
});
