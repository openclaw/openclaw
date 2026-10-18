import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { PreparedCompactionSession } from "../../agents/embedded-agent-runner/run/compaction-accounting-bridge.js";
import {
  resolveSessionWorkStartError,
  isSessionWorkStartInvalidatedError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
} from "../../config/sessions.js";
import {
  preflightSessionTranscriptForManualCompact,
  trimSessionTranscriptForManualCompact,
} from "../../config/sessions/session-accessor.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  captureSessionTarget,
  runSessionMutation,
  SessionMutationPreemptTimeoutError,
} from "../../sessions/session-controller.lifecycle.js";
import { recordSessionCompacted } from "../../sessions/session-state-events.js";
import { hasPreparedGatewayDeviceAuthority } from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
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
          { ok: true, key: target.canonicalKey, compacted: false, ...details },
          undefined,
        );
      };
      if (!sessionId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Session ${key} not found. Run openclaw sessions list --json to choose a valid key.`,
          ),
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
            }
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
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
