import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agents/agent-command-restart-recovery.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../agents/restart-recovery-prompt.js";
import type { RequesterSettleWakeParams } from "../agents/subagents/announce/subagent-announce.requester-settle-state.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
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
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { readUserTurnCompletionForTest } from "./pending-input-commit.test-support.js";
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
  completeBatch: Mock<RequesterSettleWakeParams["completeBatch"]>;
  result: Promise<boolean>;
};

export async function runPublicSettleRecoveryCase(
  reply:
    | "visible final"
    | "channel visible final"
    | "child visible final"
    | "private child final"
    | "private child parent replaced"
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
    recoverViaRpc: () => Promise<unknown>;
  },
) {
  const { requesterScope: scope, requesterSessionKey, requesterSessionId, wake } = context;
  const channelRequester = reply === "channel visible final";
  const humanWork = "Continue the previously accepted human work.";
  const settleRequest =
    "Review the child result, finish verification, and land the requested change.";
  const privateChild = reply.startsWith("private child");
  const visibleFinal =
    reply === "visible final" ||
    reply === "child visible final" ||
    privateChild ||
    channelRequester;
  const missingReply = {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
    error: "completion agent did not produce a visible reply",
  };
  const requesterOrigin = {
    sessionKey: requesterSessionKey,
    messageProvider: "telegram",
    senderId: "settle-channel-bob",
  };
  let child = context.child;
  let kernel = context.getKernel();
  let sibling = {
    ...child,
    runId: `${child.runId}-public-sibling`,
    childSessionKey: `${child.childSessionKey}-public-sibling`,
  };
  const batchRunIds = [child.runId, sibling.runId].toSorted();
  for (const entry of [child, sibling]) {
    // Missing-answer recovery still owes a reply while a child result is undelivered.
    if (reply === "progress only") {
      entry.delivery = { status: "pending" };
    }
    entry.cleanupCompletedAt = Date.now();
    entry.requesterSettleWake = {
      ...child.requesterSettleWake!,
      status: "dispatching",
      attemptCount: 1,
      batchRunIds,
    };
    context.installChild(entry);
    context.persistChild(entry);
  }
  const working = createDeferred();
  const interruptedRelease = createDeferred();
  const resumed = createDeferred();
  const resumedRelease = createDeferred();
  let recoveryRunId: string | undefined;
  let acceptedPrivateInput: unknown;
  let privateMessage: string | undefined;
  let retainedPrivateAuthority: AgentCommandOpts["operatorAuthority"];
  let releasePrivateAuthority: (() => void) | undefined;
  const runId = buildAnnounceIdempotencyKey(
    `requester-settle:main:${requesterSessionKey}:${batchRunIds.join(",")}:yield-1`,
  );
  const release = () => {
    interruptedRelease.resolve();
    resumedRelease.resolve();
  };
  const recover = () =>
    recoverRestartAbortedMainSessions({
      cfg: getRuntimeConfig(),
      stateDir: process.env.OPENCLAW_STATE_DIR!,
      gatewayRuntime: kernel.gatewayInstanceRuntime.recovery,
    });
  const transcript = () => loadTranscriptEventsSync(scope);
  const append = (message: Parameters<typeof appendTranscriptMessage>[1]["message"]) =>
    appendTranscriptMessage(scope, { cwd: process.env.OPENCLAW_STATE_DIR!, message });
  const readWake = () => loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake;
  const assertNoReplay = async () => {
    const replay = wake(sibling);
    expect(await replay.result).toBe(false);
    expect(replay.completeBatch).not.toHaveBeenCalled();
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
  };
  const assertRecoveryIdle = async (
    before: ReturnType<typeof transcript>,
    commandCount: number,
  ) => {
    await expect(recover()).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
    expect(transcript()).toEqual(before);
    expect(agentCommandMock).toHaveBeenCalledTimes(commandCount);
  };
  const assertSettled = (status: "done" | "interrupted") => {
    const settled = loadSessionEntryReadOnly(scope);
    expect(settled).toMatchObject({
      status,
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: expect.arrayContaining([runId]),
    });
    expect(settled?.mainRestartRecovery).toBeUndefined();
    expect(settled?.restartRecoveryRuns).toBeUndefined();
    return settled;
  };
  const publishTerminal = (
    command: AgentCommandOpts,
    evidence: Parameters<typeof buildRestartRecoveryTerminalDeliveryEvidence>[0],
    clearRecovery = false,
  ) =>
    updateSessionEntry(scope, (entry) => ({
      ...buildRestartRecoveryClaimCleanupPatch({
        entry,
        recordTerminalSource: true,
        terminalRunId: command.runId,
        terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(evidence),
      }),
      ...(clearRecovery ? buildMainSessionRecoveryClearPatch(entry) : {}),
      status: "done",
      endedAt: Date.now(),
    }));
  signal.addEventListener("abort", release, { once: true });
  if (reply === "unconsumed revoked cohort") {
    await append({
      role: "user",
      content: humanWork,
      provenance: { kind: "external_user" },
    });
  }
  agentCommandMock.mockImplementationOnce(async (input) => {
    const command = input as AgentCommandOpts;
    if (privateChild) {
      privateMessage = command.message;
      acceptedPrivateInput = command.userTurnTranscriptRecorder?.getPendingInputMessage?.();
    }
    await context.prepareVisibleRequesterCommand(command);
    if (reply !== "unconsumed revoked cohort") {
      await command.userTurnTranscriptRecorder!.persistApproved();
    }
    await context.markCommandExecutionStarted(command);
    await append({
      role: "assistant",
      content: [{ type: "toolCall", id: "verify-work", name: "exec", arguments: {} }],
      stopReason: "toolUse",
    });
    await append({
      role: "toolResult",
      toolCallId: "verify-work",
      toolName: "exec",
      content: [{ type: "text", text: "Changes verified; the requested landing remains." }],
      isError: false,
    });
    command.abortSignal!.addEventListener("abort", () => interruptedRelease.resolve(), {
      once: true,
    });
    working.resolve();
    await interruptedRelease.promise;
    command.abortSignal!.throwIfAborted();
    throw new Error("the Gateway restart must interrupt unfinished work");
  });
  const profile = ensureProfileForEmail(`settle-recovery-${context.sequence}@example.test`);
  const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] });
  client.connect.client.id = "openclaw-control-ui";
  client.connect.client.mode = "webchat";
  client.internal = { authenticatedOperator: true };
  client.authPolicy = captureGatewayAuthPolicy(getRuntimeConfig(), {
    role: "operator",
    authMethod: "token",
  });
  const originalSource = channelRequester
    ? undefined
    : await captureGatewayOperatorRunAuthority({
        client: captureAgentTurnPrincipal(client),
        context: kernel.gatewayRequestContext,
        sourceAuthority: null,
      });
  const requester = loadSessionEntryReadOnly(scope)!;
  const operatorRecoverySource = originalSource
    ? createRestartRecoveryOperatorSource({
        authority: originalSource.authority,
        entry: requester,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sourceRunId: runId,
      })
    : undefined;
  if (!channelRequester) {
    expect(originalSource?.authority.recoverySnapshot).toBeDefined();
    expect(operatorRecoverySource).toBeDefined();
    await updateSessionEntry(scope, () => ({
      createdActor: { type: "human", source: "profile", id: profile.id },
    }));
  }
  for (const entry of [child, sibling]) {
    entry.completionRequesterLifecycleRevision = requester.lifecycleRevision;
    entry.operatorRecoverySource = operatorRecoverySource;
    context.persistChild(entry);
    if (privateChild) {
      const continuation = await withPluginRuntimeGatewayRequestScope(
        {
          client: {
            ...client,
            internal: { ...client.internal, operatorRunAuthority: originalSource!.authority },
          },
          context: kernel.gatewayRequestContext,
          resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        () => inProcessDispatch.captureOperatorToolGatewayContinuationContext(),
      );
      subagentRuns.bindCompletionAuthority(entry, expectDefined(continuation, "Private source"));
    }
  }
  const dispatchOriginal = () =>
    inProcessDispatch.dispatchGatewayMethodInProcess<Record<string, unknown>>(
      "agent",
      {
        sessionKey: requesterSessionKey,
        idempotencyKey: runId,
        message: settleRequest,
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
        ...(channelRequester
          ? {
              agentToolCaller: {
                agentId: "main",
                sessionKey: requesterSessionKey,
                requesterOrigin,
              },
            }
          : {}),
        settleWakeReplay: context.settleWakeReplay([
          child.childSessionKey,
          sibling.childSessionKey,
        ]),
        resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
      },
    );
  const original = privateChild
    ? wake(child).result
    : channelRequester
      ? dispatchOriginal()
      : inProcessDispatch.withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: client.authenticatedUserProfile,
            scopes: ["operator.write"],
            operatorRunAuthority: originalSource!.authority,
          },
          dispatchOriginal,
        );
  void original.catch(() => {});
  let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
  try {
    await Promise.race([working.promise, original]);
    const priorDedupe = kernel.gatewayRequestContext.dedupe;
    expect(priorDedupe.get(`agent:${runId}`)?.payload).toMatchObject({ status: "accepted" });
    await context.harness.server.close({
      reason: "gateway restart",
      restartExpectedMs: 0,
      drainTimeoutMs: 0,
    });
    await original.catch(() => {});
    const interruptedEntry = loadSessionEntryReadOnly(scope);
    expect(interruptedEntry).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [expect.objectContaining({ runId })],
    });
    if (channelRequester) {
      expect(interruptedEntry?.restartRecoveryOperatorSource).toBeUndefined();
      expect(interruptedEntry?.restartRecoveryRequesterSource).toMatchObject({
        sourceRunId: runId,
        requesterOrigin,
      });
    } else {
      expect(interruptedEntry?.restartRecoveryOperatorSource).toMatchObject({
        sourceRunId: runId,
        snapshot: { profileId: profile.id, scopes: ["operator.write"] },
      });
    }
    if (reply === "missing original authority") {
      await updateSessionEntry(scope, () => ({
        restartRecoveryOperatorSource: undefined,
        restartRecoveryRequesterSource: undefined,
      }));
    }
    if (reply === "unconsumed revoked cohort") {
      for (const entry of [child, sibling]) {
        const revoked = { ...entry, requesterSettleWake: undefined };
        context.persistChild(revoked);
        context.installChild(revoked);
      }
    }
    if (reply === "private child parent replaced") {
      await updateSessionEntry({ ...scope, sessionKey: interruptedEntry!.spawnedBy! }, () => ({
        lifecycleRevision: "replaced-parent-before-private-recovery",
      }));
    }
    closeOpenClawAgentDatabasesForTest();
    await context.start();
    kernel = context.getKernel();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const { activateSubagentRegistry } =
      await import("../agents/subagents/registry/subagent-registry.js");
    if (reply === "private child parent replaced") {
      await activateSubagentRegistry(
        expectDefined(kernel.gatewayRequestContext.resolveGatewayContext, "Gateway resolver"),
      ).settled;
      await expect(recover()).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
      expect(
        agentCommandMock,
        JSON.stringify(
          agentCommandMock.mock.calls.map(([command]) => {
            const input = command as AgentCommandOpts;
            return {
              sessionKey: input.sessionKey,
              runId: input.runId,
              provenance: input.inputProvenance,
            };
          }),
        ),
      ).toHaveBeenCalledTimes(1);
      assertSettled("interrupted");
      expect(JSON.stringify(transcript())).toContain(
        "could not resume after the Gateway restarted",
      );
      expect(readWake()).toBeUndefined();
      await assertRecoveryIdle(transcript(), 1);
      return;
    }
    if (privateChild) {
      // An older Gateway may already have minted ordinary recovery custody.
      // The original private input must still retain execution and its receipt.
      expect(loadSessionEntryReadOnly(scope)?.mainRestartRecovery).toBeDefined();
      await expect(recover()).resolves.toMatchObject({ started: 0, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      await expect(context.recoverViaRpc()).resolves.toMatchObject({
        ok: false,
        error: {
          message:
            "This interrupted turn is queued for automatic recovery. Wait for its result before resuming it manually.",
        },
      });
      // A crash between input admission and backend start has the same private owner.
      await updateSessionEntry(scope, () => ({ status: undefined, abortedLastRun: false }));
      await expect(context.recoverViaRpc()).resolves.toMatchObject({
        ok: false,
        error: {
          message:
            "This interrupted turn is queued for automatic recovery. Wait for its result before resuming it manually.",
        },
      });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        expect(command.runId).toBe(runId);
        expect(command.message).toBe(privateMessage);
        expect(command.privateCompletion).toBe(true);
        expect(command.userTurnTranscriptRecorder?.getPendingInputMessage?.()).toEqual(
          acceptedPrivateInput,
        );
        const instructions = (command.runtimeContextFragments ?? [])
          .map((fragment) => fragment.text)
          .join("\n");
        expect(instructions.split(RESTART_RECOVERY_INTERRUPTION_NOTE)).toHaveLength(2);
        const authority = expectDefined(command.operatorAuthority, "Private operator authority");
        const retain = expectDefined(authority.retain, "Private operator authority retention");
        authority.assertCurrent();
        retainedPrivateAuthority = authority;
        releasePrivateAuthority = retain();
        await context.prepareVisibleRequesterCommand(command);
        await command.userTurnTranscriptRecorder!.persistApproved();
        await context.markCommandExecutionStarted(command);
        await publishTerminal(command, finalResult(), true);
        return finalResult();
      });
      const batchSettled = createDeferred();
      const stopObserving = subscribeSubagentRunChanges("persistence", () => {
        if (
          batchRunIds.every((id) => {
            const entry = subagentRuns.get(id);
            return entry !== undefined && entry.requesterSettleWake === undefined;
          })
        ) {
          batchSettled.resolve();
        }
      });
      try {
        await withinTest(
          activateSubagentRegistry(
            expectDefined(kernel.gatewayRequestContext.resolveGatewayContext, "Gateway resolver"),
          ).settled,
          signal,
        );
        // The run receipt precedes the registry's settlement of the whole batch.
        await withinTest(batchSettled.promise, signal);
      } finally {
        stopObserving();
      }
      expect(await readUserTurnCompletionForTest(scope, runId)).toMatchObject({
        outcome: { status: "ok", reason: "completed" },
      });
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      assertSettled("done");
      child = context.installChild(subagentRuns.get(child.runId)!);
      sibling = subagentRuns.get(sibling.runId)!;
      await wake(sibling).result;
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      expect(readWake()).toBeUndefined();
      await assertRecoveryIdle(transcript(), 2);
      retainedPrivateAuthority!.assertCurrent();
      const parentSessionKey = loadSessionEntryReadOnly(scope)!.spawnedBy!;
      await updateSessionEntry({ ...scope, sessionKey: parentSessionKey }, () => ({
        lifecycleRevision: "replaced-parent-after-private-recovery",
      }));
      expect(() => retainedPrivateAuthority!.assertCurrent()).toThrow();
      return;
    }
    await activateSubagentRegistry(
      expectDefined(kernel.gatewayRequestContext.resolveGatewayContext, "Gateway resolver"),
    ).settled;
    child = context.installChild(subagentRuns.get(child.runId)!);
    sibling = subagentRuns.get(sibling.runId)!;
    expect(kernel.gatewayRequestContext.dedupe).not.toBe(priorDedupe);
    if (reply === "unconsumed revoked cohort") {
      const { readMainSessionRecoveryCheckpoint } =
        await import("../agents/main-session-recovery/main-session-restart-recovery-checkpoint.js");
      expect(await readMainSessionRecoveryCheckpoint(scope)).toMatchObject({
        source: "external_user",
      });
      const contents = JSON.stringify(transcript());
      expect(contents).toContain(humanWork);
      expect(contents).not.toContain(settleRequest);
    }
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(command.sessionId).toBe(requesterSessionId);
      expect(command.runId).not.toBe(runId);
      if (channelRequester) {
        expect(command.operatorAuthority).toBeUndefined();
        expect(command.requesterOrigin).toEqual(requesterOrigin);
        expect(command.senderIsOwner).toBe(false);
      } else {
        expect(command.operatorAuthority?.profileId).toBe(profile.id);
        expect(command.operatorAuthority?.scopes).toEqual(["operator.write"]);
        command.operatorAuthority!.assertCurrent();
      }
      recoveryRunId = command.runId;
      expect(command.message?.split(RESTART_RECOVERY_INTERRUPTION_NOTE)).toHaveLength(2);
      if (reply === "unconsumed revoked cohort") {
        expect(command.inputProvenance).toMatchObject({
          kind: "internal_system",
          sourceTool: "main_session_restart_recovery",
        });
        expect(command.message).not.toContain(settleRequest);
      }
      expect(JSON.stringify(transcript())).toContain(
        "Changes verified; the requested landing remains.",
      );
      await context.markCommandExecutionStarted(command);
      resumed.resolve();
      await resumedRelease.promise;
      const rawEvidence = visibleFinal
        ? finalResult()
        : {
            payloads: [{ text: "Still checking the change.", isCommentary: true }],
          };
      // The controlled command uses the same durable final projection and
      // claim cleanup as real command finalization; Gateway admission stays real.
      await publishTerminal(command, rawEvidence, true);
      return visibleFinal ? finalResult() : { payloads: [], meta: { durationMs: 1 } };
    });
    recovery = recover();
    if (reply === "missing original authority") {
      await expect(recovery).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      const settled = assertSettled("interrupted");
      expect(settled?.sessionId).toBe(requesterSessionId);
      expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
      const events = transcript();
      expect(events.at(-1)).toMatchObject({
        message: { idempotencyKey: `main-session-restart-recovery:${runId}:interrupted` },
      });
      await assertRecoveryIdle(events, 1);
      return;
    }
    await Promise.race([
      resumed.promise,
      recovery.then((result) => expect(result).toMatchObject({ started: 1, failed: 0 })),
    ]);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    await assertNoReplay();
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
    if (reply === "unconsumed revoked cohort") {
      // The retained human work may recover; the withdrawn completion input may not.
      await assertNoReplay();
      const persisted = loadSubagentRegistryFromSqlite();
      for (const entry of [child, sibling]) {
        expect(entry.requesterSettleWake).toBeUndefined();
        expect(persisted.get(entry.runId)?.requesterSettleWake).toBeUndefined();
      }
      assertSettled("done");
      const events = transcript();
      expect(JSON.stringify(events)).toContain(humanWork);
      expect(JSON.stringify(events)).not.toContain(settleRequest);
      await assertRecoveryIdle(events, 2);
      return;
    }
    expect(child.requesterSettleWake?.nextAttemptAt).toBeUndefined();
    // Restart removed the old Gateway's dedupe cache. The already-admitted
    // settle batch must recognize its completed successor instead of rerunning.
    const reconciliationAt = Date.now();
    const completedReplay = wake(sibling);
    expect(await completedReplay.result).toBe(visibleFinal);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    const pendingWake = readWake();
    if (visibleFinal) {
      expect(pendingWake).toBeUndefined();
      expect(completedReplay.completeBatch).toHaveBeenCalledOnce();
      expect(completedReplay.completeBatch.mock.calls[0]?.[2]).toMatchObject({
        delivered: true,
      });
      expect(completedReplay.completeBatch.mock.calls[0]?.[2]?.requesterVisibleFinalDelivered).toBe(
        reply === "child visible final" || privateChild ? undefined : true,
      );
      return;
    }
    expect(completedReplay.completeBatch).not.toHaveBeenCalled();
    expect(pendingWake).toMatchObject({
      status: "pending",
      attemptCount: 1,
      batchRunIds,
      lastError: missingReply.error,
    });
    const nextAttemptAt = pendingWake?.nextAttemptAt;
    expect(nextAttemptAt).toBeGreaterThanOrEqual(reconciliationAt + 30_000);
    expect(nextAttemptAt).toBeLessThanOrEqual(Date.now() + 30_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expectDefined(nextAttemptAt, "Public retry deadline") - 1);
    await assertNoReplay();
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
      const retryAt = expectDefined(readWake()?.nextAttemptAt, "Public retry deadline");
      vi.setSystemTime(retryAt);
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        expect(command.runId).not.toBe(runId);
        expect(command.runId).not.toBe(recoveryRunId);
        expect(retryRunIds).not.toContain(command.runId);
        retryRunIds.push(expectDefined(command.runId, "Public retry run"));
        expect(command.message).toContain("provide the missing result");
        await context.prepareVisibleRequesterCommand(command);
        await command.userTurnTranscriptRecorder!.persistApproved();
        await context.markCommandExecutionStarted(command);
        const result = { payloads: [], meta: { durationMs: 1 } };
        await publishTerminal(command, { payloads: result.payloads });
        return result;
      });
      const retry = wake(sibling);
      expect(await retry.result).toBe(false);
      expect(agentCommandMock).toHaveBeenCalledTimes(attempt + 1);
      const next = readWake();
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
      ...missingReply,
      disposition: "retryable",
      phases: [
        {
          ...missingReply,
          phase: "direct-primary",
          deliveredAt: undefined,
          enqueuedAt: undefined,
        },
      ],
    });
    expect(await wake(sibling).result).toBe(false);
    expect(agentCommandMock).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
    release();
    await Promise.allSettled([original, recovery]);
    signal.removeEventListener("abort", release);
    originalSource?.release();
    releasePrivateAuthority?.();
    subagentRuns.delete(sibling.runId);
  }
}
