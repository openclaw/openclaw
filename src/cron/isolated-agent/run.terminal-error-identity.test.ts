// Protects per-invocation terminal errors in a persistent automation transcript.
import path from "node:path";
import { assert, afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { FailoverError } from "../../agents/failover-error.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

describe("persistent automation terminal error identity", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("retains distinct provider failures from sequential invocations without weakening replay guards", async () => {
    const root = tempDirs.make("openclaw-cron-terminal-identity-");
    const target = {
      agentId: "main",
      sessionId: "persistent-transcript",
      sessionKey: "agent:main:dashboard:terminal-identity",
      storePath: path.join(root, "openclaw-agent.sqlite"),
    };
    await replaceSessionEntry(target, {
      sessionId: target.sessionId,
      lifecycleRevision: "persistent-revision",
      updatedAt: 1,
      systemSent: false,
    });
    resolveCronSessionMock.mockImplementation(() => {
      const entry = loadSessionEntry(target);
      if (!entry) {
        throw new Error("Missing persistent test session");
      }
      return makeCronSession({
        storePath: target.storePath,
        store: { [target.sessionKey]: { ...entry } },
        initialSessionEntry: entry,
        sessionEntry: { ...entry },
        lifecycleRevision: entry.lifecycleRevision,
        isNewSession: false,
      });
    });
    loadSessionEntryMock.mockImplementation(() => loadSessionEntry(target));
    const runIds: string[] = [];
    const failures = ["provider refusal response-one", "provider refusal response-two"] as const;
    const messages = failures.map((errorMessage, index) =>
      makeAgentAssistantMessage({
        content: [],
        stopReason: "error",
        errorMessage,
        responseId: `response-${index + 1}`,
        timestamp: 10 + index,
      }),
    );
    runEmbeddedAgentMock.mockImplementation(async (request: RunEmbeddedAgentParams) => {
      const index = runIds.length;
      runIds.push(request.runId);
      request.onExecutionStarted?.();
      await request.userTurnTranscriptRecorder?.persistApproved({ cwd: root });
      const manager = guardSessionManager(SessionManager.open(target, root), {
        runId: request.runId,
        assistantErrorTranscript: request.assistantErrorTranscript,
      });
      const message = messages[index];
      const failure = failures[index];
      assert(message && failure);
      manager.appendMessage(message);
      throw new FailoverError(failure, { reason: "server_error" });
    });
    const params = makeIsolatedAgentParamsFixture({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      job: makeIsolatedAgentJobFixture({
        sessionTarget: `session:${target.sessionKey}`,
        delivery: { mode: "none" },
      }),
    });
    // Reuse both the job and physical transcript, in the incident's execution order.
    const first = await runCronIsolatedAgentTurn(params);
    const second = await runCronIsolatedAgentTurn(params);
    expect(first).toMatchObject({ status: "error", error: expect.stringContaining(failures[0]) });
    expect(second).toMatchObject({ status: "error", error: expect.stringContaining(failures[1]) });
    expect(new Set(runIds).size).toBe(2);
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
    const readErrors = () =>
      SessionManager.open(target, root)
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(readErrors()).toMatchObject(
      messages.map((message, index) => ({
        message: {
          errorMessage: message.errorMessage,
          responseId: message.responseId,
          __openclaw: { runId: runIds[index] },
        },
      })),
    );

    // Exact replay stays idempotent, but another response under the same key is corruption.
    const [firstMessage, secondMessage] = messages;
    const [firstRunId] = runIds;
    assert(firstMessage && secondMessage && firstRunId);
    const replay = createAssistantErrorTranscript({ runId: firstRunId });
    replay.record(firstMessage, target);
    await replay.settle(true);
    expect(readErrors()).toHaveLength(2);
    const conflict = createAssistantErrorTranscript({ runId: firstRunId });
    conflict.record(secondMessage, target);
    await expect(conflict.settle(true)).rejects.toThrow("conflicts with the admitted message");
    expect(readErrors()).toHaveLength(2);
  });
});
