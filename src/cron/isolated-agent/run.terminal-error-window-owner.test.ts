// Root metadata must not displace the active exact-run transcript owner.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { installSessionToolResultGuard } from "../../agents/session-tool-result-guard.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeIsolatedAgentParamsFixture, makeIsolatedAgentJobFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveCronSessionMock,
  loadSessionEntryMock,
  makeCronSession,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCron = await loadRunCronIsolatedAgentTurn();
describe("synthetic exact cron terminal error persistence", () => {
  it.each([false, true])(
    "persists the terminal provider error through the cron entrypoint (root rename=%s)",
    async (renameRoot) => {
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
        loadSessionEntryMock.mockImplementation(
          (lookupStorePath: string, lookupSessionKey: string) =>
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
          if (renameRoot) {
            await accessor.patchSessionEntryCore({ sessionKey, storePath }, () => ({
              label: "Renamed root",
            }));
          }
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
        const result = await runCron(
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
    },
  );
});
