// Protects per-invocation terminal errors in a persistent automation transcript.
import path from "node:path";
import { assert, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { FailoverError } from "../../agents/failover-error.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "../../agents/session-tool-result-guard.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  patchSessionEntryMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-terminal-identity-");

describe("persistent automation terminal error identity", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("retains distinct provider failures from sequential invocations", async () => {
    const root = sessionDirs.make();
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
  });
});

describe("synthetic exact cron terminal error persistence", () => {
  it("persists the terminal provider error after its root is renamed", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    await withOpenClawTestState({ label: "cron-terminal-entrypoint" }, async (state) => {
      const accessor = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.js")
      >("../../config/sessions/session-accessor.js");
      const sessionId = "synthetic-run";
      const sessionKey = "agent:main:cron:synthetic-job";
      const runKey = sessionKey + ":run:" + sessionId;
      const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const entry = { sessionId, lifecycleRevision: "synthetic-revision", updatedAt: Date.now() };
      await accessor.replaceSessionEntry({ sessionKey, storePath }, entry);
      patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
      const storedEntry = accessor.loadSessionEntry({ sessionKey, storePath })!;
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          storePath,
          store: { [sessionKey]: storedEntry },
          initialSessionEntry: storedEntry,
          sessionEntry: { ...storedEntry },
          lifecycleRevision: entry.lifecycleRevision,
          isNewSession: false,
        }),
      );
      loadSessionEntryMock.mockImplementation((lookupStorePath: string, lookupSessionKey: string) =>
        accessor.loadSessionEntry({ storePath: lookupStorePath, sessionKey: lookupSessionKey }),
      );
      runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
        expect(params.sessionKey).toBe(runKey);
        expect(params.assistantErrorTranscript).toBeDefined();
        const target = { agentId: "main", sessionId, sessionKey: runKey, storePath };
        if (!params.preparedRunAdmission) {
          throw new Error("Missing real cron admission");
        }
        const admitted = await params.preparedRunAdmission.admit("embedded");
        const assertActive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
        if (!assertActive) {
          throw new Error("Missing real cron active-owner assertion");
        }
        await accessor.patchSessionEntryCore(target, () => ({ activeWriterRunId: params.runId }));
        const fenced = {
          ...target,
          expectedWriterRunId: params.runId,
          expectedLifecycleRevision: entry.lifecycleRevision,
        };
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: fenced,
            assertCommitAllowed: assertActive,
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            const manager = SessionManager.open(fenced, state.workspaceDir);
            manager.appendMessage({ role: "user", content: "Synthetic task", timestamp: 1 });
            installSessionToolResultGuard(manager, {
              assistantErrorTranscript: params.assistantErrorTranscript,
            });
            manager.appendMessage(
              makeAgentAssistantMessage({
                content: [],
                stopReason: "error",
                errorMessage: "Synthetic provider failure",
              }),
            );
          },
        );
        const exactBefore = accessor.loadSessionEntry(target);
        await accessor.patchSessionEntryCore({ sessionKey, storePath }, () => ({
          label: "Renamed root",
        }));
        expect(accessor.loadSessionEntry(target)).toEqual(exactBefore);
        expect(accessor.loadSessionEntry(target)).toMatchObject({
          sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: params.runId,
        });
        assertActive();
        expect((await accessor.resolveSessionTranscriptRuntimeTarget(target)).sessionKey).toBe(
          runKey,
        );
        return {
          payloads: [],
          meta: {
            durationMs: 1,
            error: { kind: "test", message: "Synthetic provider failure" },
            agentMeta: { sessionId, provider: "mock", model: "mock" },
          },
        };
      });
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey: "cron:synthetic-job",
          job: makeIsolatedAgentJobFixture({ id: "synthetic-job", delivery: { mode: "none" } }),
        }),
      );
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(result.error ?? "").not.toContain("session rebound");
      const messages = SessionManager.open({
        agentId: "main",
        sessionId,
        sessionKey: runKey,
        storePath,
      })
        .getBranch()
        .filter((e) => e.type === "message");
      expect(messages).toHaveLength(2);
      expect(messages.at(-1)).toMatchObject({
        message: { stopReason: "error", errorMessage: "Synthetic provider failure" },
      });
    });
  });
});
