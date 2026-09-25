// Manual transcript trimming and model-backed session compaction.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  resolveSessionWorkStartError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import {
  applySessionPatchProjection,
  preflightSessionTranscriptForManualCompact,
  readTranscriptStatsSync,
  trimSessionTranscriptForManualCompact,
} from "../../config/sessions/session-accessor.js";
import { projectCompactionAccountingPatch } from "../../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { recordSessionCompacted } from "../../sessions/session-state-events.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  preflightGatewaySessionCompaction,
  runGatewaySessionCompaction,
} from "./sessions-compaction-runner.js";
import {
  emitSessionOperation,
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionCompactHandlers: GatewayRequestHandlers = {
  "sessions.compact": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const maxLines = params.maxLines;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      exactRead: true,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    });
    const storePath = target.storePath;
    // Lock + read in a short critical section; transcript work happens outside.
    // The projection resolver re-runs gateway key migration on the writer
    // snapshot so alias promotion/pruning persists through the accessor.
    let compactPrimaryKey = target.canonicalKey;
    const compactRead = await applySessionPatchProjection({
      agentId: target.agentId,
      sessionKeys: target.storeKeys,
      storePath,
      resolveTarget: ({ store }) => {
        const { target: migratedTarget, primaryKey } = resolveCanonicalGatewaySessionStoreKey({
          cfg,
          key,
          store: store as Record<string, SessionEntry>,
          agentId: requestedAgentId,
        });
        compactPrimaryKey = primaryKey;
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      // Read-only projection: persist the resolved row unchanged so the alias
      // migration above is saved even when compaction bails out below.
      project: ({ existingEntry }) =>
        existingEntry ? { ok: true, entry: existingEntry } : { ok: false },
    });
    const compactTarget = {
      entry: compactRead.ok ? compactRead.entry : undefined,
      primaryKey: compactPrimaryKey,
    };
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    const respondNotCompacted = (details: { ok?: boolean; kept?: number; reason?: string }) => {
      respond(
        true,
        { ok: true, key: target.canonicalKey, compacted: false, ...details },
        undefined,
      );
    };
    if (!sessionId) {
      respondNotCompacted({ reason: "no sessionId" });
      return;
    }

    if (maxLines !== undefined) {
      const trimPreflight = await preflightSessionTranscriptForManualCompact(
        {
          sessionId,
          storePath,
          sessionKey: compactTarget.primaryKey,
          agentId: target.agentId,
        },
        { maxLines },
      );
      if (!trimPreflight.compacted) {
        respondNotCompacted(
          "kept" in trimPreflight ? { kept: trimPreflight.kept } : { reason: "no transcript" },
        );
        return;
      }
    } else {
      const transcriptStats = readTranscriptStatsSync({
        agentId: target.agentId,
        sessionId,
        sessionKey: compactTarget.primaryKey,
        storePath,
      });
      if (transcriptStats.eventCount === 0) {
        respondNotCompacted({ reason: "no transcript" });
        return;
      }
    }

    const lifecycleRevision = entry.lifecycleRevision;
    const readCurrentEntry = () => {
      const latest = loadAccessorSessionEntryForGatewayTarget({
        key,
        cfg,
        agentId: requestedAgentId,
      }).entry;
      return latest &&
        latest.sessionId === sessionId &&
        latest.lifecycleRevision === lifecycleRevision &&
        !resolveSessionWorkStartError(target.canonicalKey, latest)
        ? latest
        : undefined;
    };
    const queueIdentities = [key, target.canonicalKey, compactTarget.primaryKey, sessionId];
    const lifecycleIdentities = [...queueIdentities, lifecycleRevision];
    let sessionStillCurrent = true;
    let compactionNoopReason: string | undefined;
    let blockedByActiveRun = false;
    let blockedByQueuedWork = false;
    try {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: lifecycleIdentities,
        kind: "compaction",
        prepare: async () => {
          const latestEntry = readCurrentEntry();
          if (!latestEntry) {
            sessionStillCurrent = false;
            return;
          }
          if (maxLines === undefined) {
            compactionNoopReason = (
              await preflightGatewaySessionCompaction({
                cfg,
                entry: latestEntry,
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                sessionStoreKey: compactTarget.primaryKey,
                storePath,
              })
            )?.reason;
            if (compactionNoopReason) {
              return;
            }
          }
          blockedByActiveRun =
            isCompetingSessionWorkAdmissionActive(storePath, lifecycleIdentities) ||
            (asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(
              sessionId,
            ) ??
              false) ||
            resolveVisibleActiveSessionRunState({
              context,
              requestedKey: key,
              canonicalKey: target.canonicalKey,
              sessionId,
              agentId: requestedAgentId,
              defaultAgentId: compatibilityDefaultAgentId,
            }).active;
          // Accepted work can live only in its command lane; waiting behind it
          // while holding the lifecycle fence would deadlock or drop that turn.
          blockedByQueuedWork =
            hasPendingFollowupQueueWork(queueIdentities) ||
            queueIdentities.some(
              (identity) =>
                getCommandLaneSnapshot(resolveEmbeddedSessionLane(identity)).queuedCount > 0,
            );
        },
        run: async () => {
          if (!sessionStillCurrent) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }
          if (compactionNoopReason) {
            respondNotCompacted({ ok: false, reason: compactionNoopReason });
            return;
          }
          if (blockedByQueuedWork) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} has queued work; retry after it finishes.`,
              ),
            );
            return;
          }
          if (blockedByActiveRun) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} has an active run; retry after it finishes.`,
              ),
            );
            return;
          }

          const latestEntry = readCurrentEntry();
          if (!latestEntry) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }

          const operationId = randomUUID();
          if (maxLines !== undefined) {
            const trimResult = await trimSessionTranscriptForManualCompact(
              {
                sessionId,
                storePath,
                sessionKey: compactTarget.primaryKey,
                agentId: target.agentId,
              },
              { maxLines },
            );
            respond(
              true,
              {
                ok: true,
                key: target.canonicalKey,
                compacted: trimResult.compacted,
                ...(trimResult.compacted
                  ? { kept: trimResult.kept }
                  : "kept" in trimResult
                    ? { kept: trimResult.kept }
                    : { reason: "no transcript" }),
              },
              undefined,
            );
            if (trimResult.compacted) {
              recordSessionCompacted({
                sessionKey: target.canonicalKey,
                operationId,
                sessionId,
                agentId: target.agentId ?? requestedAgentId,
              });
              emitSessionsChanged(context, {
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                reason: "compact",
                compacted: true,
              });
            }
            return;
          }

          const transcriptStats = readTranscriptStatsSync({
            agentId: target.agentId,
            sessionId,
            sessionKey: compactTarget.primaryKey,
            storePath,
          });
          if (transcriptStats.eventCount === 0) {
            respondNotCompacted({ reason: "no transcript" });
            return;
          }
          emitSessionOperation(context, {
            operationId,
            operation: "compact",
            phase: "start",
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
          });
          const emitCompactionEnd = (completed: boolean, reason?: string) =>
            emitSessionOperation(context, {
              operationId,
              operation: "compact",
              phase: "end",
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              completed,
              reason,
            });
          let result: Awaited<ReturnType<typeof runGatewaySessionCompaction>>;
          let expectedEntry: InternalSessionEntry = latestEntry;
          try {
            result = await runGatewaySessionCompaction(
              {
                cfg,
                entry: latestEntry,
                runId: operationId,
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                sessionStoreKey: compactTarget.primaryKey,
                storePath,
              },
              {
                onCommitted: (accepted) => {
                  expectedEntry = accepted.entry;
                },
              },
            );
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
            let persisted: boolean;
            try {
              // Skip terminal persistence when session ownership rotated during compaction.
              const persistProjection = await applySessionPatchProjection({
                agentId: target.agentId,
                sessionKeys: [compactTarget.primaryKey],
                storePath,
                resolveTarget: () => ({ primaryKey: compactTarget.primaryKey }),
                project: ({ existingEntry }) => {
                  if (
                    !existingEntry ||
                    existingEntry.sessionId !== expectedEntry.sessionId ||
                    existingEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
                    existingEntry.activeWriterRunId !== expectedEntry.activeWriterRunId ||
                    resolveSessionWorkStartError(target.canonicalKey, existingEntry)
                  ) {
                    return { ok: false };
                  }
                  return {
                    ok: true,
                    entry: {
                      ...existingEntry,
                      ...projectCompactionAccountingPatch(existingEntry, {
                        compactionKind: result.compactionKind,
                        tokensAfter: result.result?.tokensAfter,
                      }),
                    },
                  };
                },
              });
              persisted = persistProjection.ok;
            } catch (err) {
              emitCompactionEnd(false, formatErrorMessage(err));
              throw err;
            }
            if (!persisted) {
              const reason = `Session ${key} changed before compaction completed. Retry.`;
              emitCompactionEnd(false, reason);
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, reason, {
                  details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
                }),
              );
              return;
            }
            recordSessionCompacted({
              sessionKey: target.canonicalKey,
              operationId,
              sessionId: expectedEntry.sessionId,
              agentId: target.agentId ?? requestedAgentId,
            });
          }

          emitCompactionEnd(result.ok && result.compacted, result.reason);
          respond(
            true,
            {
              ok: result.ok,
              key: target.canonicalKey,
              compacted: result.compacted,
              reason: result.reason,
              result: result.result,
            },
            undefined,
          );
          if (result.ok) {
            emitSessionsChanged(context, {
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              reason: "compact",
              compacted: result.compacted,
            });
          }
        },
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
};
