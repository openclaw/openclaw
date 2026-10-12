import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import * as acpReads from "../../acp/runtime/session-meta-readonly.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  prime,
} from "./agent.test-harness.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";

const mocks = getAgentTestMocks();

function mockCompletedRun(sessionKey: string): void {
  const run = createSubagentRunRecord({
    runId: "previous-run",
    childSessionKey: sessionKey,
    execution: { status: "terminal", endedAt: 3 },
  });
  mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(run);
  mocks.getLatestLiveSubagentRunByChildSessionKey.mockReturnValue(run);
}

function expectReactivationFailure(respond: ReturnType<typeof vi.fn>, runId: string): void {
  expect(mocks.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    { runId, status: "error", summary: "reactivate boom" },
    { code: "UNAVAILABLE", message: "reactivate boom" },
    { runId, error: "reactivate boom" },
  );
}

export function registerAgentPreDispatchFailureTests() {
  it.each([{ acp: false }, { acp: true }, { acp: true, cancel: true }])(
    "keeps pre-dispatch reactivation with its runtime (%j)",
    async ({ acp, cancel }) => {
      await withPluginSubagentTestState("openclaw-reactivation-owner-", async () => {
        prime("reactivation-session");
        if (acp) {
          seedCanonicalAcpSessionMeta({
            sessionKey: "agent:main:main",
            sessionId: "reactivation-session",
            meta: {
              backend: "acpx",
              agent: "main",
              runtimeSessionName: "reactivation-owner",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1,
            },
          });
          mocks.agentCommand.mockResolvedValue({ payloads: [], meta: { durationMs: 1 } });
        }
        mockCompletedRun("agent:main:main");
        mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
          throw new Error("reactivate boom");
        });

        const context = makeContext();
        const runId = "idem-abort-reactivation-fails";
        const terminal = createDeferred();
        const respond = vi.fn((_ok, payload, error) => {
          if (error || payload?.status === "ok" || payload?.status === "error") {
            terminal.resolve();
          }
        });
        const read = acpReads.readAcpSessionMetaForEntries;
        const cancellation = cancel
          ? vi
              .spyOn(acpReads, "readAcpSessionMetaForEntries")
              .mockImplementationOnce(async (...args) => {
                const result = await read(...args);
                const active = context.chatAbortControllers.get(runId);
                if (!active) {
                  throw new Error("Expected the ACP read to retain run admission");
                }
                active.controller.abort(new Error("ACP preparation cancelled"));
                return result;
              })
          : undefined;
        try {
          await invokeAgent(
            {
              message: "hi",
              agentId: "main",
              sessionKey: "agent:main:main",
              idempotencyKey: runId,
            },
            { context, reqId: runId, respond },
          );
          await terminal.promise;

          expect(context.chatAbortControllers.has(runId)).toBe(false);
          if (cancel) {
            expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
            expect(mocks.agentCommand).not.toHaveBeenCalled();
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                code: "UNAVAILABLE",
                message: "ACP preparation cancelled",
              }),
            );
          } else if (acp) {
            expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
            expect(mocks.agentCommand).toHaveBeenCalledOnce();
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({ runId, status: "ok" }),
              undefined,
              expect.anything(),
            );
          } else {
            expect(mocks.agentCommand).not.toHaveBeenCalled();
            expectReactivationFailure(respond, runId);
          }
        } finally {
          cancellation?.mockRestore();
        }
      });
    },
  );

  it.each(["pending input admission", "pre-dispatch reactivation"] as const)(
    "restores admitted restart recovery if %s fails",
    async (failurePhase) => {
      const sessionKey = "agent:main:main";
      const sessionId = "recovery-session";
      const runId = "recovery-reactivation-fails";
      const storePath = getAgentTestStorePath();
      const store: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          status: "interrupted",
          abortedLastRun: true,
          restartRecoveryDeliveryRunId: runId,
          restartRecoveryDeliverySourceRunId: "interrupted-source-run",
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 1,
            chargedAttempts: 1,
            reservation: {
              runId,
              attempt: 1,
              lifecycleGeneration: "test-generation",
            },
          },
        },
      };
      mocks.loadSessionEntry.mockImplementation(() => ({
        cfg: {},
        storePath,
        entry: structuredClone(store[sessionKey]),
        canonicalKey: sessionKey,
      }));
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
      const inputError = new Error("Pending input ownership ended; submit a new turn to continue");
      if (failurePhase === "pending input admission") {
        mocks.stageSessionPendingInput.mockImplementationOnce(async () => {
          expect(store[sessionKey]?.abortedLastRun).toBe(false);
          expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
          throw inputError;
        });
      } else {
        mockCompletedRun(sessionKey);
        mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
          throw new Error("reactivate boom");
        });
      }

      const context = makeContext();
      const respond = vi.fn();
      await invokeAgent(
        {
          message: "resume after restart",
          agentId: "main",
          sessionKey,
          sessionId,
          expectedExistingSessionId: sessionId,
          idempotencyKey: runId,
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: sessionKey,
            sourceTool: "main_session_restart_recovery",
          },
        },
        { context, client: backendGatewayClient(), reqId: runId, respond },
      );

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(store[sessionKey]).toMatchObject({
        sessionId,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "interrupted-source-run",
        mainRestartRecovery: {
          chargedAttempts: 1,
        },
      });
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(store[sessionKey]?.restartRecoveryDeliveryRunId).toBeUndefined();
      if (failurePhase === "pending input admission") {
        expect(respond.mock.calls).toEqual([
          [false, undefined, { code: "UNAVAILABLE", message: inputError.message }],
        ]);
      } else {
        expectReactivationFailure(respond, runId);
      }
    },
  );

  it("releases a foreground recovery owner if pre-dispatch reactivation fails", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-reactivation-fails";
    const storePath = getAgentTestStorePath();
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mockCompletedRun(sessionKey);
    mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
      throw new Error("reactivate boom");
    });

    const respond = await invokeAgent(
      {
        message: "new foreground turn",
        agentId: "main",
        sessionKey,
        sessionId,
        idempotencyKey: runId,
      },
      { client: backendGatewayClient(), reqId: runId },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expectReactivationFailure(respond, runId);
  });

  it("releases gateway admission when foreground owner cleanup exhausts retries", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-release-fails";
    const storePath = getAgentTestStorePath();
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.applySessionEntryReplacements.mockRejectedValue(new Error("owner release write failed"));

    await expect(
      invokeAgent(
        {
          message: "new foreground turn",
          agentId: "main",
          sessionKey,
          sessionId,
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: runId,
        },
        {
          client: backendGatewayClient(),
          reqId: runId,
          respond: vi.fn(),
          flushDispatch: false,
        },
      ),
    ).rejects.toThrow("owner release write failed");
    await expect(
      runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, sessionId],
        signal: AbortSignal.timeout(100),
        run: async () => "released",
      }),
    ).resolves.toBe("released");
  });
}
