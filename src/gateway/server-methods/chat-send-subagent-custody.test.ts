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
afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

it("gives a human chat.send continuation native child custody before backend execution", async ({
  signal,
}) => {
  const fixture = await createFixture({ active: false, preserveContent: true });
  const sessionKey = "agent:main:dashboard:retained-child";
  const runId = "human-child-continuation";
  const task = "Verify the retained result instead of repeating the original task.";
  const entry = {
    sessionId: "retained-child-session",
    lifecycleRevision: "retained-child-revision",
    updatedAt: Date.now(),
    status: "done" as const,
    spawnedBy: "agent:main:main",
    parentSessionKey: "agent:main:main",
    spawnDepth: 1,
    subagentRole: "leaf" as const,
  };
  fixture.scope.sessionKey = sessionKey;
  fixture.scope.sessionId = entry.sessionId;
  fixture.params.sessionKey = sessionKey;
  fixture.params.sessionId = entry.sessionId;
  fixture.params.message = task;
  fixture.params.idempotencyKey = runId;
  await upsertSessionEntryCore(fixture.scope, entry);
  const completed = createSubagentRunRecord({
    runId: "completed-child",
    childSessionKey: sessionKey,
    childAgentId: "main",
    childSessionIdentity: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    },
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "Original completed task",
    cleanup: "keep",
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
  const actualDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
    "../../auto-reply/dispatch.js",
  );
  const actualReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
    "../../auto-reply/reply/get-reply.js",
  );
  dispatchInboundMessageMock.mockImplementation((params) =>
    actualDispatch.dispatchInboundMessage({
      ...params,
      replyResolver: actualReply.getReplyFromConfig,
    }),
  );
  try {
    const ack = await fixture.send();
    expect(ack).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "started" }),
      undefined,
      expect.anything(),
    );
    await withinTest(entered.promise, signal);
    expect(subagentRuns.get(runId)).toMatchObject({
      runId,
      childSessionKey: sessionKey,
      task,
      execution: { status: "running" },
    });
    expect(subagentRuns.get(completed.runId)).toMatchObject({
      task: "Original completed task",
      execution: { status: "terminal", outcome: { status: "ok" } },
    });
    expect(isMainRestartRecoveryCandidate(loadSessionEntry(fixture.scope)!, sessionKey)).toBe(
      false,
    );
  } finally {
    release.resolve();
    await fixture.cleanup();
  }
});
