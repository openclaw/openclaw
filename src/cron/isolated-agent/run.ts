import { randomUUID } from "node:crypto";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  createAgentRunRestartAbortError,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  consumeCronNextCheckProposal,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { createDiagnosticMessageLifecycle } from "../../logging/message-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { isCommandLaneTaskTimeoutError } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { removeCronRunContinuationSessionIfIdle } from "../../tasks/cron-run-continuation-cleanup.js";
import { CronExecutionRootRuntimeError } from "../execution-root-runtime.js";
import { createCronRunDiagnosticsFromError, mergeCronRunDiagnostics } from "../run-diagnostics.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
import {
  normalizeCronRunErrorText,
  resolveCronAbortReasonText,
} from "../service/execution-errors.js";
import type { CronAgentExecutionPhaseUpdate } from "../types.js";
import { finalizeCronRun } from "./run-finalize.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { prepareCronRunContext } from "./run-prepare.js";
import { CronSessionLifecycleClaimError, type MutableCronSession } from "./run-session-state.js";
import { applyCronRunUsage, recordCronRunUsage } from "./run-usage.js";
import { logWarn } from "./run.runtime.js";
import type { CronCompletedPromptRun, RunCronAgentTurnResult } from "./run.types.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

const cronExecutorRuntimeLoader = createLazyImportLoader(() => import("./run-executor.runtime.js"));

// Release the full session snapshot after persistence and delivery to avoid retaining skill prompts.
async function disposeCronRunContext(params: {
  runId: string;
  sessionId: string;
  cronSession: MutableCronSession;
  ownsSessionRuntime: boolean;
  runContextOwnerToken?: string;
}): Promise<void> {
  releaseAgentRunContext(params.runId, params.runContextOwnerToken);
  if (params.ownsSessionRuntime) {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "isolated-cron-dispose",
      onError: (error, sid) => {
        logWarn(
          `[cron] Failed to retire MCP runtime during isolated cron dispose ${sid}: ${String(error)}`,
        );
      },
    }).catch(() => {});
  }
  params.cronSession.store = {};
}

/** Runs one isolated cron agent turn, including setup, execution, delivery, and persistence. */
export async function runCronIsolatedAgentTurn(
  params: RunCronAgentTurnParams,
): Promise<RunCronAgentTurnResult> {
  const admittedLifecycleGeneration = getAgentEventLifecycleGeneration();
  const upstreamAbortSignal = params.abortSignal ?? params.signal;
  const lifecycleAbortController = new AbortController();
  const abortSignal = upstreamAbortSignal
    ? AbortSignal.any([upstreamAbortSignal, lifecycleAbortController.signal])
    : lifecycleAbortController.signal;
  const isAborted = () => abortSignal?.aborted ?? false;
  const abortReason = () =>
    resolveCronAbortReasonText(abortSignal?.reason) ?? "cron: job execution timed out";
  const isFastTestEnv = isFastTestRuntimeEnv();
  let prepared: Awaited<ReturnType<typeof prepareCronRunContext>>;
  try {
    prepared = await prepareCronRunContext({
      input: { ...params, abortSignal },
      isFastTestEnv,
      onLifecycleInterrupt: () => lifecycleAbortController.abort(createAgentRunRestartAbortError()),
    });
  } catch (err) {
    if (err instanceof CronExecutionRootRuntimeError) {
      return { status: "error", error: err.message, admissionDisposition: "rejected" };
    }
    if (err instanceof CronSessionLifecycleClaimError) {
      return {
        status: "error",
        error: err.message,
        admissionDisposition: err.admissionDisposition,
      };
    }
    throw err;
  }
  if (!prepared.ok) {
    return { ...prepared.result, admissionDisposition: "rejected" };
  }
  await using preparedRuntimeLease = prepared.context.preparedModelRuntimeLease;
  let leaseActive = true;
  // Accounting, delivery, and teardown use the same metadata as inference. Keep
  // the lease open until cleanup finishes, then fence detached borrowed work.
  try {
    return await withPreparedModelRuntimePluginGenerationScope(
      preparedRuntimeLease.pluginGeneration,
      () =>
        withPluginRuntimeGenerationScope(preparedRuntimeLease.snapshot, async () => {
          // One invocation owns retries and fallbacks; persistent transcripts outlive that identity.
          const runId = randomUUID();
          const initialSessionId = prepared.context.cronSession.sessionEntry.sessionId;
          const ownsSessionRuntime = params.job.sessionTarget === "isolated";
          let runContextOwnerToken: string | undefined;
          let runLifecycleGeneration = admittedLifecycleGeneration;
          let executionStarted = false;
          const notifyExecutionStarted = (info?: {
            lifecycleGeneration?: string;
            isFallback?: boolean;
            provider?: string;
            model?: string;
          }) => {
            executionStarted = true;
            if (info?.lifecycleGeneration) {
              runLifecycleGeneration = info.lifecycleGeneration;
            }
            params.onExecutionStarted?.({
              jobId: params.job.id,
              agentId: prepared.context.agentId,
              sessionId: prepared.context.currentRunSessionId(),
              sessionKey: prepared.context.runSessionKey,
              ...(info?.isFallback === true ? { isFallback: true } : {}),
              phase: "runner_entered",
              provider: info?.provider ?? prepared.context.liveSelection.provider,
              model: info?.model ?? prepared.context.liveSelection.model,
            });
          };
          const notifyExecutionPhase = (
            info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
              Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
          ) => {
            params.onExecutionPhase?.({
              jobId: params.job.id,
              agentId: prepared.context.agentId,
              sessionId: prepared.context.currentRunSessionId(),
              sessionKey: prepared.context.runSessionKey,
              provider: prepared.context.liveSelection.provider,
              model: prepared.context.liveSelection.model,
              ...info,
            });
          };

          const turnStartedAtMs = Date.now();
          const messageLifecycle = (() => {
            try {
              const lifecycle = createDiagnosticMessageLifecycle({
                enabled: isDiagnosticsEnabled(params.cfg),
                sessionId: prepared.context.runSessionId,
                sessionKey: prepared.context.runSessionKey,
                agentId: prepared.context.agentId,
                channel: "cron",
                source: "cron-isolated",
                startedAtMs: turnStartedAtMs,
                trackSessionState: true,
              });
              lifecycle.markProcessing();
              return lifecycle;
            } catch (error) {
              prepared.context.sessionWorkAdmission.release();
              throw error;
            }
          })();

          let outcome: "completed" | "error" = "completed";
          let outcomeError: string | undefined;
          let cronRunSessionCleanupHandled = false;
          let completedPromptRuns: readonly CronCompletedPromptRun[] = [];
          let usage: RunCronAgentTurnResult["usage"];
          let usageSettlement: Promise<void> | undefined;
          const settleUsage = async (contextTokens?: number) => {
            usageSettlement ??= (async () => {
              usage = applyCronRunUsage(prepared.context, completedPromptRuns);
              await recordCronRunUsage({
                prepared: prepared.context,
                runs: completedPromptRuns,
                contextTokens,
              });
              await prepared.context.persistSessionEntry();
              await prepared.context.runContinuationSession?.seal({ basePersisted: true });
            })();
            await usageSettlement;
            return usage;
          };
          // The execution owner spans fallback and interim-ack retries. Individual
          // attempts must not retire the shared run before that execution settles.
          const lifecycle = createAgentLifecycleTerminalBackstop({
            runId,
            sessionKey: prepared.context.runSessionKey,
            startedAt: turnStartedAtMs,
            getLifecycleGeneration: () => runLifecycleGeneration,
            resolveTerminationFields: (error) =>
              resolveAgentRunErrorLifecycleFields(error, abortSignal),
          });
          try {
            assertAgentRunLifecycleGenerationCurrent(runLifecycleGeneration);
            runContextOwnerToken = claimAgentRunContext(
              runId,
              {
                sessionKey: prepared.context.runSessionKey,
                sessionId: initialSessionId,
                lifecycleGeneration: runLifecycleGeneration,
                cronRunsByJobId: new Map([
                  [params.job.id, { pacingEnabled: params.job.pacing !== undefined }],
                ]),
              },
              {
                trackOwner: true,
                ownsContext: true,
              },
            );
            const { executeCronRun } = await cronExecutorRuntimeLoader.load();
            const executionParams: Parameters<typeof executeCronRun>[0] = {
              ...prepared.context,
              runId,
              cfg: params.cfg,
              job: params.job,
              lane: params.lane,
              agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
              persistRunContinuationSession: prepared.context.runContinuationSession?.sync,
              setRunContinuationCliExecutionProvider:
                prepared.context.runContinuationSession?.setCliExecutionProvider,
              abortSignal,
              lifecycle,
              onExecutionStarted: notifyExecutionStarted,
              onExecutionPhase: notifyExecutionPhase,
              onLaneWait: params.onLaneWait,
              onPromptCompleted: (runs) => {
                completedPromptRuns = runs;
              },
              abortReason,
              isAborted,
              immutableThinkLevel: prepared.context.thinkingSelection.immutableThinkLevel,
              thinkingCatalog: prepared.context.thinkingSelection.catalog,
              loadThinkingCatalog: prepared.context.thinkingSelection.loadThinkingCatalog,
              executionIdentity: params.executionIdentity,
              admissionSource: params.admissionSource,
            };
            const execution = await prepared.context.sessionWorkAdmission.run(() =>
              withAgentRunLifecycleGeneration(runLifecycleGeneration, () =>
                executeCronRun(executionParams),
              ),
            );
            // Publish the execution fact captured before bookkeeping; cron persistence
            // and delivery retain their separate workflow outcome.
            lifecycle.emit("end", execution.runResult);
            const finalized = await finalizeCronRun({
              prepared: prepared.context,
              execution,
              abortReason,
              isAborted,
              settleUsage,
              markCronRunSessionCleanupHandled: () => {
                cronRunSessionCleanupHandled = true;
              },
              // Self-deleting sessions must release before their own lifecycle mutation.
              // Other runs retain admission through delivery and release in finally.
              beforeSessionDelete: prepared.context.sessionWorkAdmission.release,
            });
            if (finalized.status === "error") {
              outcome = "error";
              outcomeError = finalized.error;
            }
            const delayMs = consumeCronNextCheckProposal(runId, params.job.id);
            return finalized.status !== "ok" || delayMs === undefined
              ? finalized
              : { ...finalized, nextCheck: { delayMs } };
          } catch (err) {
            lifecycle.emit("error", err);
            consumeCronNextCheckProposal(runId, params.job.id);
            const isCronLaneTimeout =
              isAborted() || isCommandLaneTaskTimeoutError(err, CommandLane.CronNested);
            const error = isCronLaneTimeout ? abortReason() : normalizeCronRunErrorText(err);
            // Preserve the provider's closed reason before user-facing text replaces the error object.
            const errorReason = resolveCronRunErrorReason(
              isCronLaneTimeout ? error : err,
              prepared.context.liveSelection.provider,
            );
            outcome = "error";
            outcomeError = error;
            const admissionDisposition =
              err instanceof CronSessionLifecycleClaimError
                ? err.admissionDisposition
                : err instanceof CronExecutionRootRuntimeError || !executionStarted
                  ? "rejected"
                  : undefined;
            if (completedPromptRuns.length > 0) {
              try {
                await settleUsage();
              } catch (usageError) {
                if (usageError !== err) {
                  logWarn(
                    `[cron:${params.job.id}] Failed to settle completed prompt usage: ${String(usageError)}`,
                  );
                }
              }
            }
            return prepared.context.withRunSession({
              status: "error",
              error,
              errorClassification: errorReason
                ? { kind: "reason", reason: errorReason }
                : undefined,
              executionStarted,
              usage,
              ...(admissionDisposition ? { admissionDisposition } : {}),
              // Carry the already-resolved run model into the error/timeout row so
              // Task-run history keeps provider/model attribution instead of looking like
              // an un-attributed cron timeout. finalizeCronRun does the same via
              // telemetry on the aborted path; this catch never reaches it.
              provider: prepared.context.liveSelection.provider,
              model: prepared.context.liveSelection.model,
              diagnostics: mergeCronRunDiagnostics(
                prepared.context.preflightDiagnostics,
                createCronRunDiagnosticsFromError(
                  isCronLaneTimeout ? "cron-setup" : "agent-run",
                  isCronLaneTimeout ? error : err,
                ),
              ),
            });
          } finally {
            try {
              await prepared.context.runContinuationSession?.seal();
            } catch (sealError) {
              logWarn(
                `[cron:${params.job.id}] Failed to seal run continuation during cleanup: ${String(sealError)}`,
              );
            }
            // Final lifecycle events use the adopted run session when the agent persisted one.
            const finalSessionRef = {
              sessionId: prepared.context.currentRunSessionId(),
              sessionKey: prepared.context.runSessionKey,
            };
            try {
              messageLifecycle.markIdle(undefined, finalSessionRef);
              messageLifecycle.markProcessed(outcome, {
                ...finalSessionRef,
                error: outcomeError,
              });
            } finally {
              try {
                if (!cronRunSessionCleanupHandled) {
                  await cleanupCronRunSessionAfterRun({
                    job: params.job,
                    agentSessionKey: prepared.context.agentSessionKey,
                    sessionId: prepared.context.currentRunSessionId(),
                    lifecycleRevision: prepared.context.cronSession.lifecycleRevision,
                    sessionUpdatedAt: prepared.context.cronSession.sessionEntry.updatedAt,
                    beforeDelete: prepared.context.sessionWorkAdmission.release,
                    reason: "cron-delete-after-run-finally",
                  });
                }
              } finally {
                // Release admission before exact-run alias deletion starts its own lifecycle mutation.
                try {
                  try {
                    await disposeCronRunContext({
                      runId,
                      sessionId: initialSessionId,
                      cronSession: prepared.context.cronSession,
                      ownsSessionRuntime,
                      runContextOwnerToken,
                    });
                  } finally {
                    prepared.context.sessionWorkAdmission.release();
                  }
                  if (prepared.context.runContinuationSession) {
                    try {
                      await removeCronRunContinuationSessionIfIdle(prepared.context.runSessionKey);
                    } catch (error) {
                      logWarn(
                        `[cron:${params.job.id}] Failed to remove unused run continuation: ${String(error)}`,
                      );
                    }
                  }
                } finally {
                  // Only run-scoped browser identities end here; persistent targets keep tracked tabs.
                  if (prepared.context.runSessionKey !== prepared.context.agentSessionKey) {
                    await cleanupBrowserSessionsForLifecycleEnd({
                      cfg: prepared.context.cfgWithAgentDefaults,
                      sessionKeys: [prepared.context.runSessionKey],
                      onWarn: (message) => logWarn(`[cron:${params.job.id}] ${message}`),
                    });
                  }
                }
              }
            }
          }
        }),
      () => (leaseActive ? preparedRuntimeLease.snapshot : undefined),
    );
  } finally {
    leaseActive = false;
  }
}
