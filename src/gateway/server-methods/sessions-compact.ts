import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { PreparedCompactionSession } from "../../agents/embedded-agent-runner/run/compaction-accounting-bridge.js";
import { resolveQueuedDelegateCounts } from "../../auto-reply/continuation/delegate-store.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import {
  resolveSessionWorkStartError,
  isSessionWorkStartInvalidatedError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  preflightSessionTranscriptForManualCompact,
  trimSessionTranscriptForManualCompact,
} from "../../config/sessions/session-accessor.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  captureSessionTarget,
  runSessionMutation,
  SessionMutationPreemptTimeoutError,
} from "../../sessions/session-controller.lifecycle.js";
import { recordSessionCompacted } from "../../sessions/session-state-events.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { hasPreparedGatewayDeviceAuthority } from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { resolveSessionModelRef } from "../session-utils.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { respondError } from "./response.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { waitForTerminalSessionRunSettlement } from "./session-run-settlement.js";
import {
  prepareGatewaySessionCompaction,
  runGatewaySessionCompaction,
} from "./sessions-compaction-runner.js";
import { emitSessionOperation, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/sessions");

function buildManualCompactionReleaseFollowupRun(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  model: { provider: string; model: string };
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  targetAgentId: string;
  workspaceDir: string;
}): FollowupRun {
  const deliveryContext = deliveryContextFromSession(params.entry);
  const cwd = normalizeOptionalString(params.entry.spawnedCwd);
  return {
    prompt: "",
    enqueuedAt: Date.now(),
    ...(deliveryContext?.channel ? { originatingChannel: deliveryContext.channel } : {}),
    ...(deliveryContext?.to ? { originatingTo: deliveryContext.to } : {}),
    ...(deliveryContext?.accountId ? { originatingAccountId: deliveryContext.accountId } : {}),
    ...(deliveryContext?.threadId !== undefined
      ? { originatingThreadId: deliveryContext.threadId }
      : {}),
    run: {
      agentId: params.targetAgentId,
      agentDir: params.workspaceDir,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      ...(cwd ? { cwd } : {}),
      config: params.cfg,
      provider: params.model.provider,
      model: params.model.model,
      ...(deliveryContext?.channel ? { messageProvider: deliveryContext.channel } : {}),
      ...(deliveryContext?.accountId ? { agentAccountId: deliveryContext.accountId } : {}),
      timeoutMs: 0,
      blockReplyBreak: "message_end",
    },
  };
}

async function sessionHasPostCompactionDelegates(params: {
  entry?: SessionEntry;
  sessionKey: string;
}): Promise<boolean> {
  const counts = await resolveQueuedDelegateCounts(params.sessionKey);
  return (
    (params.entry?.pendingPostCompactionDelegates?.length ?? 0) > 0 ||
    counts.stagedPostCompaction > 0
  );
}

async function releaseManualPostCompactionDelegatesIfNeeded(params: {
  cfg: OpenClawConfig;
  compactionCount: number | undefined;
  entry: SessionEntry;
  model: { provider: string; model: string };
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  targetAgentId: string;
  workspaceDir: string;
}): Promise<void> {
  if (!(await sessionHasPostCompactionDelegates(params))) {
    return;
  }
  try {
    const { releasePostCompactionDelegatesAfterCompaction } =
      await import("../../auto-reply/reply/agent-runner-post-compaction-release.js");
    await releasePostCompactionDelegatesAfterCompaction({
      activeSessionStore: params.store,
      compactionCount: params.compactionCount,
      followupRun: buildManualCompactionReleaseFollowupRun(params),
      sessionEntry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } catch (error) {
    log.warn(
      `[sessions.compact:post-compaction-release-failed] session=${params.sessionKey} reason=${formatErrorMessage(error)}`,
    );
  }
}

export const sessionCompactHandlers: GatewayRequestHandlers = {
  "sessions.compact": async (options) => {
    const { params, respond, context, client, signal, hasCurrentClientAuthority } = options;
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const maxLines = params.maxLines;
    const sessionChangedError = () =>
      errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before compaction. Retry.`, {
        details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
      });

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
    let capturedOperator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    const assertRequestCurrent = () => {
      requestAuthority.assertCurrent();
      capturedOperator?.authority.assertCurrent();
    };
    try {
      const target = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key,
        agentId: requestedAgentId,
        assertActive: assertRequestCurrent,
      });
      const storePath = target.storePath;
      if (maxLines === undefined) {
        capturedOperator = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          invocationAuthority: { assertCurrent: requestAuthority.assertCurrent, signal },
        });
      }
      const sourceSignal = capturedOperator?.authority.signal;
      const abortSignal =
        signal && sourceSignal ? AbortSignal.any([signal, sourceSignal]) : (signal ?? sourceSignal);
      assertRequestCurrent();
      const compactPrimaryKey = target.canonicalKey;
      const entry = target.store[compactPrimaryKey];
      const sessionId = entry?.sessionId;
      const respondNotCompacted = (details: { ok?: boolean; kept?: number; reason?: string }) => {
        respond(
          true,
          {
            ok: true,
            key: target.canonicalKey,
            compacted: false,
            ...details,
            ...(details.reason === "no transcript"
              ? { reason: "No chat history to compact." }
              : {}),
          },
          undefined,
        );
      };
      if (!sessionId) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} not found. Run openclaw sessions list --json to choose a valid key.`,
        );
        return;
      }
      const transcriptScope = {
        agentId: target.agentId,
        sessionId,
        sessionKey: compactPrimaryKey,
        storePath,
      };

      if (maxLines !== undefined) {
        const trimPreflight = await preflightSessionTranscriptForManualCompact(transcriptScope, {
          maxLines,
        });
        assertRequestCurrent();
        if (!trimPreflight.compacted) {
          respondNotCompacted(
            "kept" in trimPreflight ? { kept: trimPreflight.kept } : { reason: "no transcript" },
          );
          return;
        }
      }

      const lifecycleRevision = entry.lifecycleRevision;
      const queueIdentities = [key, target.canonicalKey, compactPrimaryKey, sessionId];
      const lifecycleIdentities = [...queueIdentities, lifecycleRevision];
      let admissionError: ReturnType<typeof errorShape> | undefined;
      let compactionNoopReason: string | undefined;
      let preparedEntry: InternalSessionEntry | undefined;
      let preparedSession: PreparedCompactionSession | undefined;
      const terminalSettled = await waitForTerminalSessionRunSettlement({
        context,
        storePath,
        requestedKey: key,
        canonicalKey: target.canonicalKey,
        sessionId,
        agentId: requestedAgentId,
        defaultAgentId: compatibilityDefaultAgentId,
        signal: abortSignal,
        liveRuns: "preempt",
      });
      await runSessionMutation({
        diagnosticLabel: "compact",
        target: captureSessionTarget({
          storeScope: storePath,
          sessionKey: target.canonicalKey,
          aliases: lifecycleIdentities,
          incarnation: sessionId,
          agentId: target.agentId,
        }),
        kind: "compaction",
        policy: "preempt",
        preempt: {
          activeRun: "abort-if-abortable",
          waitingInputs: "keep",
          shouldPreempt: () => admissionError === undefined && compactionNoopReason === undefined,
        },
        assertCurrent: assertRequestCurrent,
        signal: abortSignal,
        prepare: async () => {
          assertRequestCurrent();
          if (maxLines === undefined) {
            const prepared = await prepareGatewaySessionCompaction({
              cfg,
              entry,
              abortSignal,
              agentId: target.agentId,
              sessionId,
              sessionKey: target.canonicalKey,
              sessionStoreKey: compactPrimaryKey,
              storePath,
            });
            preparedEntry = prepared.entry;
            if (
              !preparedEntry ||
              preparedEntry.sessionId !== sessionId ||
              preparedEntry.lifecycleRevision !== lifecycleRevision ||
              resolveSessionWorkStartError(target.canonicalKey, preparedEntry)
            ) {
              admissionError = sessionChangedError();
              return;
            }
            preparedSession = prepared.preparedSession;
            compactionNoopReason = prepared.reason;
            if (compactionNoopReason) {
              return;
            }
          }
          const blockedByActiveRun =
            !terminalSettled ||
            (getWorkerInferenceSessionControl(context.workerEnvironmentService)?.hasSession(
              sessionId,
            ) ??
              false);
          if (blockedByActiveRun) {
            admissionError = errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} has an active run; retry after it finishes.`,
            );
          }
        },
        run: async () => {
          assertRequestCurrent();
          // The controller has settled its captured competitors; remote projections still block.
          if (
            !admissionError &&
            !compactionNoopReason &&
            resolveVisibleActiveSessionRunState({
              storePath,
              resolveGatewayContext: context.resolveGatewayContext,
              requestedKey: key,
              canonicalKey: target.canonicalKey,
              sessionId,
              agentId: requestedAgentId,
              defaultAgentId: compatibilityDefaultAgentId,
            }).active
          ) {
            admissionError = errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} has an active run; retry after it finishes.`,
            );
          }
          if (admissionError) {
            respond(false, undefined, admissionError);
            return;
          }
          if (compactionNoopReason === "no transcript") {
            respondNotCompacted({ reason: "no transcript" });
            return;
          }
          if (compactionNoopReason) {
            respondNotCompacted({ ok: false, reason: compactionNoopReason });
            return;
          }
          const operationId = randomUUID();
          const emitCompacted = (compacted: boolean) =>
            emitSessionsChanged(context, {
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              reason: "compact",
              compacted,
            });
          if (maxLines !== undefined) {
            const trimResult = await trimSessionTranscriptForManualCompact(transcriptScope, {
              maxLines,
              authority: {
                // Router authorization already includes the request's live authority.
                source:
                  options.sessionMutationAuthorization?.assertCurrent ??
                  requestAuthority.assertCurrent,
                assertHostCurrent: () => {
                  signal?.throwIfAborted();
                  if (!hasPreparedGatewayDeviceAuthority(client, hasCurrentClientAuthority)) {
                    throw new Error("Gateway requester authority changed");
                  }
                },
                expectedLifecycleRevision: lifecycleRevision,
                expectedSource: target.capturedReadSource,
              },
            });
            if (trimResult.compacted) {
              await recordSessionCompacted({
                sessionKey: target.canonicalKey,
                operationId,
                sessionId,
                agentId: target.agentId ?? requestedAgentId,
              });
            }
            respond(
              true,
              {
                ok: true,
                key: target.canonicalKey,
                compacted: trimResult.compacted,
                ...("kept" in trimResult ? { kept: trimResult.kept } : { reason: "no transcript" }),
              },
              undefined,
            );
            if (trimResult.compacted) {
              // Release staged post-compaction delegates only from the current row read after
              // the trim. Without one, they stay staged: a row read before the lifecycle fence
              // is not authority to release them.
              const entryAfterTrim = await readSessionEntryReadOnlyInWorker(
                { ...transcriptScope, readConsistency: "latest" },
                assertRequestCurrent,
              )
                .then((latest) => {
                  assertRequestCurrent();
                  return latest &&
                    latest.sessionId === sessionId &&
                    latest.lifecycleRevision === lifecycleRevision &&
                    !resolveSessionWorkStartError(target.canonicalKey, latest)
                    ? latest
                    : undefined;
                })
                .catch(() => undefined);
              const targetAgentId = target.agentId ?? requestedAgentId;
              if (entryAfterTrim) {
                await releaseManualPostCompactionDelegatesIfNeeded({
                  cfg,
                  compactionCount: entryAfterTrim.compactionCount ?? 0,
                  entry: entryAfterTrim,
                  model: resolveSessionModelRef(cfg, entryAfterTrim, targetAgentId),
                  sessionFile: formatSqliteSessionFileMarker({
                    agentId: targetAgentId,
                    sessionId: entryAfterTrim.sessionId ?? sessionId,
                    storePath,
                  }),
                  sessionId: entryAfterTrim.sessionId ?? sessionId,
                  sessionKey: target.canonicalKey,
                  store: { [target.canonicalKey]: entryAfterTrim },
                  storePath,
                  targetAgentId,
                  workspaceDir:
                    normalizeOptionalString(entryAfterTrim.spawnedWorkspaceDir) ??
                    resolveAgentWorkspaceDir(cfg, targetAgentId),
                });
              }
              emitCompacted(true);
            }
            return;
          }

          // The lifecycle owner spans preparation and execution.
          const latestEntry = preparedEntry;
          if (!latestEntry) {
            respond(false, undefined, sessionChangedError());
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
          let persisted = false;
          let boundaryTokensAfter: number | undefined;
          // Continuation: the row the accounting fallback committed, when it ran.
          let releaseSessionEntry: SessionEntry | undefined;
          let expectedEntry: InternalSessionEntry = latestEntry;
          const assertActive = () => {
            assertRequestCurrent();
            abortSignal?.throwIfAborted();
          };
          try {
            result = await runGatewaySessionCompaction(
              {
                cfg,
                entry: latestEntry,
                abortSignal,
                runId: operationId,
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                sessionStoreKey: compactPrimaryKey,
                storePath,
              },
              {
                assertActive,
                preparedSession,
                // Aliases can share a transcript but own different accounting rows.
                withCompactionPersistenceAsync:
                  preparedSession?.sessionTarget.sessionKey === compactPrimaryKey
                    ? async (prepared) => {
                        const committed = await persistCompactionBoundaryWithSessionEntryAsync(
                          prepared.scope,
                          {
                            prepared,
                            tokensAfter: prepared.event.tokensAfter,
                            transcriptByteCompactionLatch: null,
                          },
                          assertActive,
                        );
                        expectedEntry = committed.entry;
                        persisted = true;
                        boundaryTokensAfter = prepared.event.tokensAfter;
                        return committed;
                      }
                    : undefined,
                sourceAuthority: { assertActive, operatorAuthority: capturedOperator?.authority },
                onCommitted: (accepted) => {
                  expectedEntry = accepted.entry;
                },
              },
            );
            if (
              result.ok &&
              result.compacted &&
              (!persisted || boundaryTokensAfter !== result.result?.tokensAfter)
            ) {
              const persistedEntry = await applySessionEntryOperation(
                transcriptScope,
                {
                  kind: "compaction-accounting",
                  expected: {
                    sessionId: expectedEntry.sessionId,
                    lifecycleRevision: expectedEntry.lifecycleRevision,
                    activeWriterRunId: expectedEntry.activeWriterRunId,
                  },
                  accounting: {
                    compactionKind: result.compactionKind,
                    amount: persisted ? 0 : undefined,
                    tokensAfter: result.result?.tokensAfter ?? (persisted ? null : undefined),
                    transcriptByteCompactionLatch:
                      result.compactionKind === "native-harness" ? undefined : null,
                  },
                },
                { skipMaintenance: true, assertCommitAllowed: assertActive },
              );
              persisted =
                persistedEntry !== null &&
                persistedEntry.sessionId === expectedEntry.sessionId &&
                persistedEntry.lifecycleRevision === expectedEntry.lifecycleRevision &&
                persistedEntry.activeWriterRunId === expectedEntry.activeWriterRunId;
              if (persisted && persistedEntry) {
                releaseSessionEntry = persistedEntry;
              }
            }
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
            if (!persisted) {
              const reason = `Session ${key} changed before compaction completed. Retry.`;
              emitCompactionEnd(false, reason);
              respondError(respond, ErrorCodes.INVALID_REQUEST, reason, {
                details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
              });
              return;
            }
            // Release staged post-compaction delegates from the row this compaction committed.
            const releaseEntry: SessionEntry = releaseSessionEntry ?? expectedEntry;
            const targetAgentId = target.agentId ?? requestedAgentId;
            await releaseManualPostCompactionDelegatesIfNeeded({
              cfg,
              compactionCount: releaseEntry.compactionCount ?? 0,
              entry: releaseEntry,
              model: resolveSessionModelRef(cfg, releaseEntry, targetAgentId),
              sessionFile: formatSqliteSessionFileMarker({
                agentId: targetAgentId,
                sessionId: releaseEntry.sessionId ?? result.result?.sessionId ?? sessionId,
                storePath,
              }),
              sessionId: releaseEntry.sessionId ?? result.result?.sessionId ?? sessionId,
              sessionKey: target.canonicalKey,
              store: { [target.canonicalKey]: releaseEntry },
              storePath,
              targetAgentId,
              workspaceDir:
                normalizeOptionalString(releaseEntry.spawnedWorkspaceDir) ??
                resolveAgentWorkspaceDir(cfg, targetAgentId),
            });
            await recordSessionCompacted({
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
            emitCompacted(result.compacted);
          }
        },
      });
    } catch (err) {
      if (err instanceof SessionMutationPreemptTimeoutError) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} has an active run; retry after it finishes.`,
        );
        return;
      }
      respond(
        false,
        undefined,
        maxLines !== undefined && isSessionWorkStartInvalidatedError(err)
          ? sessionChangedError()
          : errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)),
      );
    } finally {
      capturedOperator?.release();
    }
  },
};
