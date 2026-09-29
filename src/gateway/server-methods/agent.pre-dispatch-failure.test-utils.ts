import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  backendGatewayClient,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  prime,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

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
  it("removes the chatAbortControllers entry if pre-dispatch reactivation fails", async () => {
    prime("reactivation-session");
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
      createSubagentRunRecord({
        runId: "previous-run",
        childSessionKey: "agent:main:main",
        execution: { status: "terminal", endedAt: 3 },
      }),
    );
    mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
      throw new Error("reactivate boom");
    });

    const context = makeContext();
    const runId = "idem-abort-reactivation-fails";
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectReactivationFailure(respond, runId);
  });

  it.each(["pending input admission", "pre-dispatch reactivation"] as const)(
    "restores admitted restart recovery if %s fails",
    async (failurePhase) => {
      const sessionKey = "agent:main:main";
      const sessionId = "recovery-session";
      const runId = "recovery-reactivation-fails";
      const storePath = "/tmp/sessions.json";
      const store: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          status: "running",
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
        mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
          createSubagentRunRecord({
            runId: "previous-run",
            childSessionKey: sessionKey,
            execution: { status: "terminal", endedAt: 3 },
          }),
        );
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
        status: "running",
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
    const storePath = "/tmp/sessions.json";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
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
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
      createSubagentRunRecord({
        runId: "previous-run",
        childSessionKey: sessionKey,
        execution: { status: "terminal", endedAt: 3 },
      }),
    );
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
    const storePath = "/tmp/sessions.json";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
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
      runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        signal: AbortSignal.timeout(100),
        run: async () => "released",
      }),
    ).resolves.toBe("released");
  });
}
