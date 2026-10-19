import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agents/agent-command-restart-recovery.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import type { RequesterSettleWakeBatchCallbacks } from "../agents/subagents/announce/subagent-announce.requester-settle-state.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import type { GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createRequesterFinalResult as finalResult } from "./server.subagent-settle-replay.test-support.js";
import { agentCommandMock, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

type GatewayKernel = Awaited<
  ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>
>;
type RequesterScope = PendingInputScope & { sessionKey: string; storePath: string };
type SettleReplay = {
  completeBatch: Mock<RequesterSettleWakeBatchCallbacks["completeBatch"]>;
  result: Promise<boolean>;
};

export async function runPublicSettleRecoveryCase(
  reply:
    | "visible final"
    | "progress only"
    | "missing original authority"
    | "unconsumed revoked cohort",
  signal: AbortSignal,
  context: {
    child: SubagentRunRecord;
    harness: GatewayServerHarness;
    getKernel: () => GatewayKernel;
    requesterSessionKey: string;
    requesterSessionId: string;
    requesterScope: RequesterScope;
    sequence: number;
    installChild: (entry: SubagentRunRecord) => SubagentRunRecord;
    persistChild: (entry: SubagentRunRecord) => void;
    start: () => Promise<void>;
    wake: (entry: SubagentRunRecord) => SettleReplay;
    settleWakeReplay: (sourceSessionKeys: string[]) => {
      sourceSessionKeys: string[];
      assertCurrent: () => void;
    };
    prepareVisibleRequesterCommand: (command: AgentCommandOpts) => Promise<RequesterScope>;
    markCommandExecutionStarted: (command: AgentCommandOpts) => Promise<void>;
  },
) {
  const {
    harness,
    getKernel,
    requesterSessionKey,
    requesterSessionId,
    requesterScope,
    sequence,
    installChild,
    persistChild,
    start,
    wake,
    settleWakeReplay,
    prepareVisibleRequesterCommand,
    markCommandExecutionStarted,
  } = context;
  let child = context.child;
  let kernel = getKernel();
  let sibling = {
    ...child,
    runId: `${child.runId}-public-sibling`,
    childSessionKey: `${child.childSessionKey}-public-sibling`,
  };
  const batchRunIds = [child.runId, sibling.runId].toSorted();
  for (const entry of [child, sibling]) {
    entry.cleanupCompletedAt = Date.now();
    entry.requesterSettleWake = {
      ...child.requesterSettleWake!,
      status: "dispatching",
      attemptCount: 1,
      batchRunIds,
    };
    installChild(entry);
    persistChild(entry);
  }
  const working = createDeferred();
  const interruptedRelease = createDeferred();
  const resumed = createDeferred();
  const resumedRelease = createDeferred();
  let recoveryRunId: string | undefined;
  const scope = requesterScope;
  const runId = buildAnnounceIdempotencyKey(
    `requester-settle:main:${requesterSessionKey}:${batchRunIds.join(",")}:yield-1`,
  );
  const release = () => {
    interruptedRelease.resolve();
    resumedRelease.resolve();
  };
  signal.addEventListener("abort", release, { once: true });
  if (reply === "unconsumed revoked cohort") {
    await appendTranscriptMessage(scope, {
      cwd: process.env.OPENCLAW_STATE_DIR!,
      message: {
        role: "user",
        content: "Continue the previously accepted human work.",
        provenance: { kind: "external_user" },
      },
    });
  }
  agentCommandMock.mockImplementationOnce(async (input) => {
    const command = input as AgentCommandOpts;
    await prepareVisibleRequesterCommand(command);
    if (reply !== "unconsumed revoked cohort") {
      await command.userTurnTranscriptRecorder!.persistApproved();
    }
    await markCommandExecutionStarted(command);
    await appendTranscriptMessage(scope, {
      cwd: process.env.OPENCLAW_STATE_DIR!,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "verify-work", name: "exec", arguments: {} }],
        stopReason: "toolUse",
      },
    });
    await appendTranscriptMessage(scope, {
      cwd: process.env.OPENCLAW_STATE_DIR!,
      message: {
        role: "toolResult",
        toolCallId: "verify-work",
        toolName: "exec",
        content: [{ type: "text", text: "Changes verified; the requested landing remains." }],
        isError: false,
      },
    });
    command.abortSignal!.addEventListener("abort", () => interruptedRelease.resolve(), {
      once: true,
    });
    working.resolve();
    await interruptedRelease.promise;
    command.abortSignal!.throwIfAborted();
    throw new Error("the Gateway restart must interrupt unfinished work");
  });
  const profile = ensureProfileForEmail(`settle-recovery-${sequence}@example.test`);
  const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] });
  client.connect.client.id = "openclaw-control-ui";
  client.connect.client.mode = "webchat";
  client.internal = { authenticatedOperator: true };
  client.authPolicy = captureGatewayAuthPolicy(getRuntimeConfig(), {
    role: "operator",
    authMethod: "token",
  });
  const originalSource = await captureGatewayOperatorRunAuthority({
    client: captureAgentTurnPrincipal(client),
    context: kernel.gatewayRequestContext,
    sourceAuthority: null,
  });
  expect(originalSource?.authority.recoverySnapshot).toBeDefined();
  const requester = loadSessionEntryReadOnly(scope)!;
  const operatorRecoverySource = createRestartRecoveryOperatorSource({
    authority: originalSource!.authority,
    entry: requester,
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    sourceRunId: runId,
  });
  expect(operatorRecoverySource).toBeDefined();
  for (const entry of [child, sibling]) {
    entry.completionRequesterLifecycleRevision = requester.lifecycleRevision;
    entry.operatorRecoverySource = operatorRecoverySource;
    persistChild(entry);
  }
  await updateSessionEntry(scope, () => ({
    createdActor: { type: "human", source: "profile", id: profile.id },
  }));
  const original = inProcessDispatch
    .withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: client.authenticatedUserProfile,
        scopes: ["operator.write"],
        operatorRunAuthority: originalSource!.authority,
      },
      () =>
        inProcessDispatch.dispatchGatewayMethodInProcess<Record<string, unknown>>(
          "agent",
          {
            sessionKey: requesterSessionKey,
            idempotencyKey: runId,
            message: "Review the child result, finish verification, and land the requested change.",
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: child.childSessionKey,
              sourceChannel: "internal",
              sourceTool: "subagent_settle",
            },
          },
          {
            expectFinal: true,
            forceSyntheticClient: true,
            operatorRoleActor: { kind: "system" },
            settleWakeReplay: settleWakeReplay([child.childSessionKey, sibling.childSessionKey]),
            resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
          },
        ),
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
  try {
    await Promise.race([
      working.promise,
      original.then((result) => {
        if ("error" in result) {
          throw result.error;
        }
      }),
    ]);
    const priorDedupe = kernel.gatewayRequestContext.dedupe;
    expect(priorDedupe.get(`agent:${runId}`)?.payload).toMatchObject({ status: "accepted" });
    await harness.server.close({
      reason: "gateway restart",
      restartExpectedMs: 0,
      drainTimeoutMs: 0,
    });
    await original;
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [expect.objectContaining({ runId })],
      restartRecoveryOperatorSource: {
        sourceRunId: runId,
        snapshot: { profileId: profile.id, scopes: ["operator.write"] },
      },
    });
    if (reply === "missing original authority" || reply === "unconsumed revoked cohort") {
      await updateSessionEntry(scope, () => ({ restartRecoveryOperatorSource: undefined }));
    }
    if (reply === "unconsumed revoked cohort") {
      for (const entry of [child, sibling]) {
        const revoked = { ...entry, requesterSettleWake: undefined };
        persistChild(revoked);
        installChild(revoked);
      }
    }
    closeOpenClawAgentDatabasesForTest();
    await start();
    kernel = getKernel();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const { activateSubagentRegistry } =
      await import("../agents/subagents/registry/subagent-registry.js");
    await activateSubagentRegistry(
      expectDefined(kernel.gatewayRequestContext.resolveGatewayContext, "Gateway resolver"),
    );
    child = installChild(subagentRuns.get(child.runId)!);
    sibling = subagentRuns.get(sibling.runId)!;
    expect(kernel.gatewayRequestContext.dedupe).not.toBe(priorDedupe);
    if (reply === "unconsumed revoked cohort") {
      const { readMainSessionRecoveryCheckpoint } =
        await import("../agents/main-session-recovery/main-session-restart-recovery-checkpoint.js");
      expect(await readMainSessionRecoveryCheckpoint(scope)).toMatchObject({
        source: "external_user",
      });
    }
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(command.sessionId).toBe(requesterSessionId);
      expect(command.runId).not.toBe(runId);
      expect(command.operatorAuthority?.profileId).toBe(profile.id);
      expect(command.operatorAuthority?.scopes).toEqual(["operator.write"]);
      command.operatorAuthority!.assertCurrent();
      recoveryRunId = command.runId;
      expect(command.message).toContain("restart");
      expect(JSON.stringify(loadTranscriptEventsSync(scope))).toContain(
        "Changes verified; the requested landing remains.",
      );
      await markCommandExecutionStarted(command);
      resumed.resolve();
      await resumedRelease.promise;
      const rawEvidence =
        reply === "visible final"
          ? finalResult()
          : {
              payloads: [{ text: "Still checking the change.", isCommentary: true }],
            };
      // The controlled command uses the same durable final projection and
      // claim cleanup as real command finalization; Gateway admission stays real.
      await updateSessionEntry(scope, (entry) => ({
        ...buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalRunId: command.runId,
          terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(rawEvidence),
        }),
        ...buildMainSessionRecoveryClearPatch(entry),
        status: "done",
        endedAt: Date.now(),
      }));
      return reply === "visible final" ? finalResult() : { payloads: [], meta: { durationMs: 1 } };
    });
    recovery = recoverRestartAbortedMainSessions({
      cfg: getRuntimeConfig(),
      stateDir: process.env.OPENCLAW_STATE_DIR!,
      gatewayRuntime: kernel.gatewayInstanceRuntime.recovery,
    });
    if (reply === "missing original authority" || reply === "unconsumed revoked cohort") {
      await expect(recovery).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      const settled = loadSessionEntryReadOnly(scope);
      expect(settled).toMatchObject({
        sessionId: requesterSessionId,
        status: "interrupted",
        abortedLastRun: false,
        restartRecoveryTerminalRunIds: expect.arrayContaining([runId]),
      });
      expect(settled?.mainRestartRecovery).toBeUndefined();
      expect(settled?.restartRecoveryRuns).toBeUndefined();
      expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
      const transcript = loadTranscriptEventsSync(scope);
      expect(transcript.at(-1)).toMatchObject({
        message: { idempotencyKey: `main-session-restart-recovery:${runId}:interrupted` },
      });
      await expect(
        recoverRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          stateDir: process.env.OPENCLAW_STATE_DIR!,
          gatewayRuntime: kernel.gatewayInstanceRuntime.recovery,
        }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      return;
    }
    await Promise.race([
      resumed.promise,
      recovery.then((result) => expect(result).toMatchObject({ started: 1, failed: 0 })),
    ]);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    const pendingReplay = wake(sibling);
    expect(await pendingReplay.result).toBe(false);
    expect(pendingReplay.completeBatch).not.toHaveBeenCalled();
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    // Let the real recovery owner settle its startup admission before the
    // controlled command publishes its synthetic terminal claim cleanup.
    await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
    resumedRelease.resolve();
    expect(recoveryRunId).toBeDefined();
    await expect(
      kernel.gatewayInstanceRuntime.recovery.waitForAgent({
        runId: recoveryRunId!,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(child.requesterSettleWake?.nextAttemptAt).toBeUndefined();
    // Restart removed the old Gateway's dedupe cache. The already-admitted
    // settle batch must recognize its completed successor instead of rerunning.
    const reconciliationAt = Date.now();
    const completedReplay = wake(sibling);
    expect(await completedReplay.result).toBe(reply === "visible final");
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    const persisted = loadSubagentRegistryFromSqlite().get(child.runId);
    if (reply === "visible final") {
      expect(persisted?.requesterSettleWake).toBeUndefined();
      expect(completedReplay.completeBatch).toHaveBeenCalledOnce();
      expect(completedReplay.completeBatch.mock.calls[0]?.[2]).toMatchObject({
        delivered: true,
        requesterVisibleFinalDelivered: true,
      });
    } else {
      expect(completedReplay.completeBatch).not.toHaveBeenCalled();
      expect(persisted?.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 1,
        batchRunIds,
        lastError: "completion agent did not produce a visible reply",
      });
      expect(persisted?.requesterSettleWake?.nextAttemptAt).toBeGreaterThanOrEqual(
        reconciliationAt + 30_000,
      );
      expect(persisted?.requesterSettleWake?.nextAttemptAt).toBeLessThanOrEqual(
        Date.now() + 30_000,
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(
        expectDefined(persisted?.requesterSettleWake?.nextAttemptAt, "Public retry deadline") - 1,
      );
      const early = wake(sibling);
      expect(await early.result).toBe(false);
      expect(early.completeBatch).not.toHaveBeenCalled();
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      expect(
        loadSessionEntryReadOnly(scope)?.restartRecoveryTerminalDeliveryEvidence?.find(
          (evidence) => evidence.runId === runId,
        ),
      ).toEqual({
        runId,
        captured: true,
        payloads: [{ visible: false }],
        transcriptRunId: recoveryRunId,
      });
      const retryRunIds: string[] = [];
      let terminalRetry: ReturnType<typeof wake> | undefined;
      for (const attempt of [2, 3]) {
        const retryAt = expectDefined(
          loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake?.nextAttemptAt,
          "Public retry deadline",
        );
        vi.setSystemTime(retryAt);
        agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.runId).not.toBe(runId);
          expect(command.runId).not.toBe(recoveryRunId);
          expect(retryRunIds).not.toContain(command.runId);
          retryRunIds.push(expectDefined(command.runId, "Public retry run"));
          expect(command.message).toContain("provide the missing result");
          await prepareVisibleRequesterCommand(command);
          await command.userTurnTranscriptRecorder!.persistApproved();
          await markCommandExecutionStarted(command);
          const result = { payloads: [], meta: { durationMs: 1 } };
          await updateSessionEntry(scope, (entry) => ({
            ...buildRestartRecoveryClaimCleanupPatch({
              entry,
              recordTerminalSource: true,
              terminalRunId: command.runId,
              terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence({
                payloads: result.payloads,
              }),
            }),
            status: "done",
            endedAt: Date.now(),
          }));
          return result;
        });
        const retry = wake(sibling);
        expect(await retry.result).toBe(false);
        expect(agentCommandMock).toHaveBeenCalledTimes(attempt + 1);
        const next = loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake;
        if (attempt === 2) {
          expect(retry.completeBatch).not.toHaveBeenCalled();
          expect(next).toMatchObject({
            status: "pending",
            attemptCount: 2,
            nextAttemptAt: retryAt + 120_000,
          });
        } else {
          expect(next).toBeUndefined();
          terminalRetry = retry;
        }
      }
      expect(terminalRetry?.completeBatch).toHaveBeenCalledOnce();
      expect(terminalRetry?.completeBatch.mock.calls[0]?.[2]).toEqual({
        delivered: false,
        path: "direct",
        disposition: "retryable",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        phases: [
          {
            phase: "direct-primary",
            delivered: false,
            path: "direct",
            deliveredAt: undefined,
            enqueuedAt: undefined,
            reason: "visible_reply_missing",
            error: "completion agent did not produce a visible reply",
          },
        ],
      });
      expect(await wake(sibling).result).toBe(false);
      expect(agentCommandMock).toHaveBeenCalledTimes(4);
    }
  } finally {
    vi.useRealTimers();
    release();
    await Promise.allSettled([original, recovery]);
    signal.removeEventListener("abort", release);
    originalSource?.release();
    subagentRuns.delete(sibling.runId);
  }
}
