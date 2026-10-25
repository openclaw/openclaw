import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { agentCommand } from "../agents/agent-command.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { RequesterSettleWakeParams } from "../agents/subagents/announce/subagent-announce.requester-settle-state.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { readReplySourceInput } from "../auto-reply/reply/reply-source-binding.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { getSessionControllerSourceIdentity } from "../sessions/session-controller.identity.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import type { GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { agentCommandMock, dispatchInboundMessageMock, rpcReq } from "./test-helpers.js";

export const createRequesterFinalResult = (): Exclude<
  Awaited<ReturnType<typeof agentCommand>>,
  void
> => ({
  payloads: [{ text: "Requester synthesis is complete.", mediaUrl: null }],
  meta: { durationMs: 1, finalAssistantVisibleText: "Requester synthesis is complete." },
  deliveryStatus: {
    requested: true,
    attempted: true,
    succeeded: true,
    status: "sent",
    resultCount: 1,
  },
});

export async function runTombstonedRequesterSettleCase(
  action: "resume" | "replace",
  context: {
    child: SubagentRunRecord;
    harness: GatewayServerHarness;
    requesterScope: PendingInputScope & { sessionKey: string; storePath: string };
    saveChild: (entry: SubagentRunRecord) => void;
    restoreChildren: (entries: SubagentRunRecord[]) => void;
    wake: () => {
      completeBatch: Mock<RequesterSettleWakeParams["completeBatch"]>;
      result: Promise<boolean>;
    };
    markCommandExecutionStarted: (command: AgentCommandOpts) => Promise<void>;
    recoverViaRpc: (params: {
      key: string;
      mode: "in-place";
      sessionId: string;
      recoveryCycleId: string;
    }) => Promise<unknown>;
  },
) {
  const { child, requesterScope: scope } = context;
  const lifecycleRevision = `tombstoned-${child.runId}`;
  await persistSessionTranscriptTurn(scope, {
    updateMode: "none",
    messages: [
      {
        message: {
          role: "user",
          content: "Wait for the child result and report the synthetic findings.",
          timestamp: Date.now(),
        },
      },
    ],
  });
  await updateSessionEntry(scope, () => ({
    lifecycleRevision,
    status: "failed",
    abortedLastRun: false,
    mainRestartRecovery: {
      cycleId: `recovery-${child.runId}`,
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "Restart recovery requester has no matching operator authority." },
    },
  }));
  child.completionTarget = "parent";
  child.delivery = { status: "pending" };
  child.completionRequesterLifecycleRevision = lifecycleRevision;
  child.requesterSettleWake = {
    status: "pending",
    attemptCount: 0,
    requesterYieldBatch: true,
    rearmGeneration: 1,
    batchRunIds: [child.runId],
  };
  context.saveChild(child);
  const readChild = () => loadSubagentRegistryFromSqlite().get(child.runId);
  const retained = structuredClone(readChild());
  const before = await loadTranscriptEvents(scope);
  for (let attempt = 0; attempt < 2; attempt++) {
    context.restoreChildren([child]);
    const blocked = context.wake();
    expect(await blocked.result).toBe(false);
    expect(blocked.completeBatch).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(readChild()).toEqual(retained);
  }
  const afterBlocked = await loadTranscriptEvents(scope);
  const isMessage = (event: unknown) =>
    isRecord(event) && event.type === "message" && isRecord(event.message);
  const isResumeNotice = (event: unknown) =>
    isMessage(event) &&
    JSON.stringify(event).includes(child.runId) &&
    JSON.stringify(event).includes("Resume");
  const notices = afterBlocked.slice(before.length).filter(isMessage);
  expect(notices).toHaveLength(1);
  expect(afterBlocked.filter(isResumeNotice)).toHaveLength(1);
  expect(loadSessionEntryReadOnly(scope)?.mainRestartRecovery?.tombstone).toBeDefined();

  if (action === "replace") {
    await updateSessionEntry(scope, () => ({ lifecycleRevision: `${lifecycleRevision}-replaced` }));
    await context.wake().result;
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(readChild()?.completion).toEqual(retained?.completion);
    expect(readChild()?.requesterSettleWake).toBeUndefined();
    expect(await loadTranscriptEvents(scope)).toEqual(afterBlocked);
    return;
  }

  const reader = await context.harness.openClient({ scopes: ["operator.read"] });
  try {
    expect(
      await rpcReq(reader.ws, "sessions.recover", {
        key: scope.sessionKey,
        mode: "in-place",
        sessionId: scope.sessionId,
        recoveryCycleId: `recovery-${child.runId}`,
      }),
    ).toMatchObject({
      ok: false,
    });
    expect(loadSessionEntryReadOnly(scope)?.mainRestartRecovery?.tombstone).toBeDefined();
    expect(readChild()).toEqual(retained);
  } finally {
    reader.ws.close();
  }
  const resumed = createDeferred();
  const finishResume = createDeferred();
  dispatchInboundMessageMock.mockImplementation(async ({ ctx, replyOptions }) => {
    try {
      expect(ctx.SessionKey).toBe(scope.sessionKey);
      // This loopback harness has no authenticated profile; the RPC source owns admission.
      const input = expectDefined(readReplySourceInput(replyOptions), "Resume RPC input");
      expect(getSessionControllerSourceIdentity(input)).toMatchObject({
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        agentId: scope.agentId,
      });
      expectDefined(input.sourceAdapter?.authority, "Resume RPC authority").assertCurrent();
      resumed.resolve();
    } catch (error) {
      resumed.reject(error);
      throw error;
    }
    await finishResume.promise;
    return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
  });
  try {
    expect(
      await context.recoverViaRpc({
        key: scope.sessionKey,
        mode: "in-place",
        sessionId: scope.sessionId,
        recoveryCycleId: `recovery-${child.runId}`,
      }),
    ).toMatchObject({
      ok: true,
      payload: { continuation: { status: "started" } },
    });
    await resumed.promise;
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      sessionId: scope.sessionId,
      lifecycleRevision,
    });
    expect(loadSessionEntryReadOnly(scope)?.mainRestartRecovery?.tombstone).toBeUndefined();
    const settled = captureSessionControllerSettlement({
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
    });
    finishResume.resolve();
    await settled;
  } finally {
    finishResume.resolve();
    dispatchInboundMessageMock.mockReset();
  }
  agentCommandMock.mockImplementationOnce(async (command) => {
    expect(command.privateCompletion).toBe(true);
    expect(command.message).toContain("isolated child result");
    await command.userTurnTranscriptRecorder!.persistApproved();
    await context.markCommandExecutionStarted(command);
    return createRequesterFinalResult();
  });
  const delivered = context.wake();
  expect(await delivered.result).toBe(true);
  expect(delivered.completeBatch).toHaveBeenCalledOnce();
  expect(readChild()?.requesterSettleWake).toBeUndefined();
  expect(readChild()?.completion).toEqual(retained?.completion);
  expect(agentCommandMock).toHaveBeenCalledOnce();
  context.restoreChildren([child]);
  await context.wake().result;
  expect(agentCommandMock).toHaveBeenCalledOnce();
  expect((await loadTranscriptEvents(scope)).filter(isResumeNotice)).toHaveLength(1);
}
