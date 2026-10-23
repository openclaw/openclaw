import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import * as harness from "./run.test-harness.js";

const runCron = await harness.loadRunCronIsolatedAgentTurn();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-terminal-identity-");

function persistentSession(target: { sessionKey: string; storePath: string }, entry: SessionEntry) {
  return harness.makeCronSession({
    storePath: target.storePath,
    store: { [target.sessionKey]: { ...entry } },
    initialSessionEntry: entry,
    sessionEntry: { ...entry },
    lifecycleRevision: entry.lifecycleRevision,
    isNewSession: false,
  });
}

describe("cron terminal error persistence", () => {
  beforeEach(() => {
    harness.resetRunCronIsolatedAgentTurnHarness();
    harness.mockRunCronFallbackPassthrough();
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
    harness.resolveCronSessionMock.mockImplementation(() =>
      persistentSession(target, expectDefined(loadSessionEntry(target), "persistent test session")),
    );
    harness.loadSessionEntryMock.mockImplementation(() => loadSessionEntry(target));
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
    harness.runEmbeddedAgentMock.mockImplementation(async (request: RunEmbeddedAgentParams) => {
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
      cfg: { session: { store: target.storePath } },
      sessionKey: target.sessionKey,
      job: makeIsolatedAgentJobFixture({
        sessionTarget: `session:${target.sessionKey}`,
        delivery: { mode: "none" },
      }),
    });
    // Reuse both the job and physical transcript, in the incident's execution order.
    const first = await runCron(params);
    const second = await runCron(params);
    expect(first).toMatchObject({ status: "error", error: expect.stringContaining(failures[0]) });
    expect(second).toMatchObject({ status: "error", error: expect.stringContaining(failures[1]) });
    expect(new Set(runIds).size).toBe(2);
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
    expect(
      SessionManager.open(target, root)
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ).toMatchObject(
      messages.map(({ errorMessage, responseId }, index) => ({
        message: { errorMessage, responseId, __openclaw: { runId: runIds[index] } },
      })),
    );
  });
  it("persists the terminal provider error after its root is renamed", async () => {
    await withOpenClawTestState({ label: "cron-terminal-entrypoint" }, async (state) => {
      const accessor = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.js")
      >("../../config/sessions/session-accessor.js");
      const sessionId = "synthetic-run";
      const sessionKey = "agent:main:cron:synthetic-job";
      const runKey = sessionKey + ":run:" + sessionId;
      const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const target = { agentId: "main", sessionId, sessionKey: runKey, storePath };
      const failure = "Synthetic provider failure";
      const entry = { sessionId, lifecycleRevision: "synthetic-revision", updatedAt: Date.now() };
      await accessor.replaceSessionEntry({ sessionKey, storePath }, entry);
      harness.patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
      const storedEntry = accessor.loadSessionEntry({ sessionKey, storePath })!;
      harness.resolveCronSessionMock.mockReturnValue(
        persistentSession({ sessionKey, storePath }, storedEntry),
      );
      harness.loadSessionEntryMock.mockImplementation(
        (lookupStorePath: string, lookupSessionKey: string) =>
          accessor.loadSessionEntry({ storePath: lookupStorePath, sessionKey: lookupSessionKey }),
      );
      harness.runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentParams) => {
          expect(params.sessionKey).toBe(runKey);
          expect(params.assistantErrorTranscript).toBeDefined();
          assert(params.preparedRunAdmission, "Missing real cron admission");
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const assertActive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
          assert(assertActive, "Missing real cron active-owner assertion");
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
                  errorMessage: failure,
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
              error: { kind: "test", message: failure },
              agentMeta: { sessionId, provider: "mock", model: "mock" },
            },
          };
        },
      );
      const result = await runCron(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          cfg: { session: { store: storePath } },
          sessionKey: "cron:synthetic-job",
          job: makeIsolatedAgentJobFixture({ id: "synthetic-job", delivery: { mode: "none" } }),
        }),
      );
      expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(result.error ?? "").not.toContain("session rebound");
      const messages = SessionManager.open(target)
        .getBranch()
        .filter((e) => e.type === "message");
      expect(messages).toHaveLength(2);
      expect(messages.at(-1)).toMatchObject({
        message: { stopReason: "error", errorMessage: failure },
      });
    });
  });
});
