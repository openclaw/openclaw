import { hasMainSessionRecoveryClaim } from "./restart-recovery-state.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Finite runtime facts derived from the worker's authoritative row before publication. */
export function projectIncognitoSessionRuntimeFacts(
  entry: InternalSessionEntry | undefined,
): Pick<IncognitoSessionFacts, "delivery" | "media" | "policy" | "steering"> {
  return {
    delivery: entry
      ? { sessionId: entry.sessionId, updatedAt: entry.updatedAt, delivery: entry.delivery }
      : undefined,
    media: entry
      ? {
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt,
          lifecycleRevision: entry.lifecycleRevision,
          permissionMode: entry.permissionMode,
          execNode: entry.execNode,
          repositoryWorkspaceId: entry.repositoryWorkspaceId,
          worktreeId: entry.worktree?.id,
          sessionRoot: entry.sessionRoot,
          spawnedCwd: entry.spawnedCwd,
          spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
          pendingWorktree: entry.pendingWorktree,
          pendingProjectGitUrl: entry.pendingProjectGitUrl,
        }
      : undefined,
    policy: entry
      ? {
          sessionId: entry.sessionId,
          sandbox: entry.sandbox,
          sandboxMode: entry.sandboxMode,
          createdActor: entry.createdActor,
          agentRuntimeOverride: entry.agentRuntimeOverride,
          nativeRuntimeConsent: entry.nativeRuntimeConsent,
          permissionMode: entry.permissionMode,
          execHost: entry.execHost,
          execNode: entry.execNode,
        }
      : undefined,
    steering: entry
      ? {
          lifecycleRevision: entry.lifecycleRevision,
          lifecycleRunId: entry.lifecycleRunId,
          startedAt: entry.startedAt,
          abortedLastRun: entry.abortedLastRun,
          spawnDepth: entry.spawnDepth,
          subagentRole: entry.subagentRole,
          hasRecoveryClaim: hasMainSessionRecoveryClaim(entry),
          activeWriterRunId: entry.activeWriterRunId,
          restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
          restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext,
          pendingFinalDeliveryContext: entry.pendingFinalDelivery?.context,
          sendPolicy: entry.sendPolicy,
          chatType: entry.chatType,
          restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion,
          restartRecoveryTerminalDeliveryEvidence:
            entry.restartRecoveryTerminalDeliveryEvidence?.map((receipt) => ({
              runId: receipt.runId,
              harnessCompletion: receipt.harnessCompletion,
              deliveryContext: receipt.deliveryContext,
              payloads: receipt.payloads?.map(({ visible }) => ({ visible })),
              payloadsTruncated: receipt.payloadsTruncated,
              deliveryStatus: receipt.deliveryStatus && {
                status: receipt.deliveryStatus.status,
                resultCount: receipt.deliveryStatus.resultCount,
              },
              messagingToolSentTargets: receipt.messagingToolSentTargets?.map(
                ({
                  provider,
                  accountId,
                  to,
                  threadId,
                  threadImplicit,
                  threadSuppressed,
                  visible,
                  sourceReplyFinal,
                }) => ({
                  provider,
                  accountId,
                  to,
                  threadId,
                  threadImplicit,
                  threadSuppressed,
                  visible,
                  sourceReplyFinal,
                }),
              ),
              messagingToolSentTargetsTruncated: receipt.messagingToolSentTargetsTruncated,
              messagingToolAggregateEvidenceUnaccounted:
                receipt.messagingToolAggregateEvidenceUnaccounted,
            })),
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt,
          status: entry.status,
          restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
          restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
          restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
          restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
          restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
        }
      : undefined,
  };
}
