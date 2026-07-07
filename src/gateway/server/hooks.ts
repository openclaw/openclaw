// Gateway hook server wiring translates external hook requests into wake events or isolated agent runs.
import { randomUUID } from "node:crypto";
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { sanitizeInboundSystemTags } from "../../auto-reply/reply/inbound-text.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { markCronJobActive, clearCronJobActive } from "../../cron/active-jobs.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import {
  createCronAgentTimeoutGuard,
  CRON_AGENT_TIMEOUT_MARKER,
  type CronAgentTimeoutGuard,
} from "../../cron/service/agent-watchdog.js";
import {
  tryCreateCronRunLedgerRow,
  tryFinishCronRunLedgerRow,
} from "../../cron/service/task-runs.js";
import { resolveCronJobTimeoutMs } from "../../cron/service/timeout-policy.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  registerActiveCronTaskRun,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
} from "../../tasks/cron-task-cancel.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { cleanupTimedOutIsolatedAgentRun } from "../timed-out-agent-run-cleanup.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

/**
 * Gateway hook HTTP handler factory.
 *
 * Hooks can either enqueue wake events or spawn isolated agent turns; both paths
 * sanitize external input before it reaches logs or system-event text.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const isolatedAgentRuntimeLoader = createLazyImportLoader(
  () => import("../../cron/isolated-agent.js"),
);

const HOOK_CANCEL_MARKER: unique symbol = Symbol("hook-agent-cancelled");

function resolveHookEventSessionKey(params: { cfg: OpenClawConfig; agentId?: string }): string {
  return params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
}

function shouldAnnounceHookRunResult(params: {
  deliver: boolean;
  result: RunCronAgentTurnResult;
}): boolean {
  if (params.result.status !== "ok") {
    return true;
  }
  return (
    params.deliver && params.result.delivered !== true && params.result.deliveryAttempted !== true
  );
}

function resolveHookRunSummary(result: RunCronAgentTurnResult): string {
  const diagnosticsSummary =
    result.status !== "ok" ? normalizeOptionalString(result.diagnostics?.summary) : undefined;
  return (
    diagnosticsSummary ||
    normalizeOptionalString(result.summary) ||
    normalizeOptionalString(result.error) ||
    result.status
  );
}

/** Session key the run will actually use, so ledger drill-down opens the real transcript. */
function resolveHookTaskChildSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string | undefined;
}): string {
  // Mirror the run's own agent/mainKey resolution (run.ts prepare path); a
  // plain DEFAULT_AGENT_ID fallback would orphan drill-down when the config
  // names a different default agent or a non-"main" mainKey alias (#29683).
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveDefaultAgentId(params.cfg);
  return resolveCronAgentSessionKey({
    sessionKey: params.sessionKey,
    agentId,
    mainKey: params.cfg.session?.mainKey,
    cfg: params.cfg,
  });
}

function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function formatHookRunWarningConsoleMessage(params: {
  status: string;
  model: string | undefined;
  summary: string;
}): string {
  const parts = [
    "hook agent run returned non-ok status",
    `status=${sanitizeHookConsoleValue(params.status) ?? "unknown"}`,
  ];
  const model = sanitizeHookConsoleValue(params.model);
  if (model) {
    parts.push(`model=${model}`);
  }
  const summary = sanitizeHookConsoleValue(params.summary);
  if (summary) {
    parts.push(`summary=${summary}`);
  }
  return parts.join(" ");
}

/** Creates the HTTP handler used by gateway hook endpoints. */
export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;
  const ledgerWarn = (meta: Record<string, unknown>, message: string) =>
    logHooks.warn(message, meta);

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, {
      sessionKey,
    });
    if (value.mode === "now") {
      requestHeartbeat({ source: "hook", intent: "immediate", reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = randomUUID();
    const runId = randomUUID();
    const nowMs = resolveDateTimestampMs(Date.now());
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: resolveTimestampMsToIsoString(nowMs) },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: nowMs },
    };

    void (async () => {
      // Yield first: the ledger insert below is a synchronous state-DB write
      // and must not delay the HTTP ack this dispatch already returned for.
      await Promise.resolve();
      const startedAt = Date.now();
      let hookEventSessionKey: string | undefined;
      const announce = (text: string, heartbeatReason: string | undefined) => {
        enqueueSystemEvent(text, {
          sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig(),
        });
        if (heartbeatReason && value.wakeMode === "now") {
          requestHeartbeat({ source: "hook", intent: "immediate", reason: heartbeatReason });
        }
      };
      let activeJobMarker: ReturnType<typeof markCronJobActive> = undefined;
      let taskRunId: string | undefined;
      const finishLedger = (outcome: {
        status: "ok" | "skipped" | "error";
        failStatus?: "failed" | "timed_out" | "cancelled";
        error?: string;
        summary?: string;
      }) =>
        tryFinishCronRunLedgerRow({
          warn: ledgerWarn,
          taskRunId,
          status: outcome.status,
          failStatus: outcome.failStatus,
          error: outcome.error,
          summary: outcome.summary,
          endedAt: Date.now(),
        });
      let guard: CronAgentTimeoutGuard | undefined;
      let releaseTaskRun: (() => void) | undefined;
      let cancelReason: string | undefined;
      const logLateSettlement = (runPromise: Promise<RunCronAgentTurnResult>, after: string) => {
        void runPromise.then(
          (lateResult) => {
            logHooks.warn(`hook agent run settled after ${after}`, {
              runId,
              name: safeName,
              status: lateResult.status,
            });
          },
          (lateErr: unknown) => {
            logHooks.warn(`hook agent run rejected after ${after}`, {
              runId,
              name: safeName,
              error: String(lateErr),
            });
          },
        );
      };
      try {
        // Agent hooks run after the HTTP response path has returned, so failure
        // handling must record a system event instead of throwing to the caller.
        const cfg = getRuntimeConfig();
        hookEventSessionKey = resolveHookEventSessionKey({ cfg, agentId: value.agentId });
        // Registry maintenance treats a cron-runtime ledger row as live only
        // while its sourceId is an active job marker; without it a hook run
        // longer than the reconcile grace is flipped to "lost" mid-run.
        activeJobMarker = markCronJobActive(jobId);
        taskRunId = tryCreateCronRunLedgerRow({
          warn: ledgerWarn,
          job,
          runId,
          childSessionKey: resolveHookTaskChildSessionKey({
            cfg,
            sessionKey,
            agentId: value.agentId,
          }),
          label: `Hook: ${safeName}`,
          progressSummary: "Running hook agent turn.",
          startedAt,
        });
        const jobTimeoutMs = resolveCronJobTimeoutMs(job);
        guard =
          jobTimeoutMs !== undefined
            ? createCronAgentTimeoutGuard({ jobTimeoutMs, deferUntilRunner: true })
            : undefined;
        const runAbortController = guard?.abortController ?? new AbortController();
        let resolveCancelled: ((value: typeof HOOK_CANCEL_MARKER) => void) | undefined;
        const cancelledPromise = new Promise<typeof HOOK_CANCEL_MARKER>((resolve) => {
          resolveCancelled = resolve;
        });
        releaseTaskRun = registerActiveCronTaskRun({
          runId,
          controller: runAbortController,
          onCancel: (reason) => {
            cancelReason = reason;
            resolveCancelled?.(HOOK_CANCEL_MARKER);
          },
        });
        // The module load stays inside the guarded core so a hung import is
        // still covered by the setup watchdog instead of silently vanishing.
        const corePromise = (async () => {
          const { runCronIsolatedAgentTurn } = await isolatedAgentRuntimeLoader.load();
          return await runCronIsolatedAgentTurn({
            cfg,
            deps,
            job,
            message: value.message,
            sessionKey,
            lane: "cron",
            abortSignal: runAbortController.signal,
            onExecutionStarted: guard?.watchdog.noteRunnerStarted,
            onExecutionPhase: guard?.watchdog.notePhase,
            onLaneWait: guard?.watchdog.noteLaneState,
          });
        })();
        trackActiveCronTaskRunSettlement(corePromise);
        guard?.watchdog.start();
        const raced = await Promise.race([
          corePromise,
          cancelledPromise,
          ...(guard ? [guard.timeoutPromise] : []),
        ]);
        if (raced === HOOK_CANCEL_MARKER) {
          // Operator cancel / gateway drain: cancelActiveCronTaskRun already
          // starts settlement grace and the registry row is marked terminal by
          // the cancel path, so report quietly instead of as a hook failure.
          logLateSettlement(corePromise, "cancel");
          logHooks.info("hook agent run cancelled", {
            runId,
            jobId,
            name: safeName,
            reason: cancelReason,
          });
          finishLedger({
            status: "error",
            failStatus: "cancelled",
            error: cancelReason ?? "Cancelled.",
          });
          return;
        }
        if (raced === CRON_AGENT_TIMEOUT_MARKER) {
          const error =
            guard?.timeoutReason() ?? `hook agent run timed out after ${jobTimeoutMs}ms`;
          startActiveCronTaskRunSettlementGrace();
          logLateSettlement(corePromise, "timeout");
          await cleanupTimedOutIsolatedAgentRun({
            execution: guard?.watchdog.activeExecution(),
            reason: "hook_timeout",
            retireReason: "hook-timeout-cleanup",
            warn: ledgerWarn,
          });
          logHooks.warn("hook agent run timed out", {
            sourcePath: value.sourcePath,
            name: safeName,
            runId,
            jobId,
            agentId: value.agentId,
            sessionKey,
            timeoutMs: jobTimeoutMs,
            consoleMessage: `hook agent run timed out name=${sanitizeHookConsoleValue(safeName) ?? "unknown"} timeoutMs=${jobTimeoutMs}`,
          });
          announce(`Hook ${safeName} (timeout): ${error}`, `hook:${jobId}:timeout`);
          finishLedger({ status: "error", failStatus: "timed_out", error });
          return;
        }
        const result = raced;
        const summary = resolveHookRunSummary(result);
        const prefix =
          result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
        const shouldAnnounce = shouldAnnounceHookRunResult({ deliver: value.deliver, result });
        if (result.status !== "ok") {
          logHooks.warn("hook agent run returned non-ok status", {
            sourcePath: value.sourcePath,
            name: safeName,
            runId,
            jobId,
            agentId: value.agentId,
            sessionKey,
            status: result.status,
            model: value.model,
            summary,
            consoleMessage: formatHookRunWarningConsoleMessage({
              status: result.status,
              model: value.model,
              summary,
            }),
          });
        }
        if (shouldAnnounce) {
          announce(`${prefix}: ${summary}`.trim(), `hook:${jobId}`);
        } else if (result.status === "ok" && !value.deliver) {
          logHooks.info("hook agent run completed without announcement", {
            sourcePath: value.sourcePath,
            name: safeName,
            runId,
            jobId,
            agentId: value.agentId,
            sessionKey,
            completedAt: new Date().toISOString(),
          });
        }
        finishLedger({
          status: result.status === "skipped" ? "skipped" : result.status === "ok" ? "ok" : "error",
          error: result.status === "ok" || result.status === "skipped" ? undefined : summary,
          summary,
        });
      } catch (err) {
        if (cancelReason !== undefined) {
          logHooks.info("hook agent run cancelled", {
            runId,
            jobId,
            name: safeName,
            reason: cancelReason,
          });
          finishLedger({ status: "error", failStatus: "cancelled", error: cancelReason });
          return;
        }
        logHooks.warn(`hook agent failed: ${String(err)}`);
        announce(`Hook ${safeName} (error): ${String(err)}`, `hook:${jobId}:error`);
        finishLedger({ status: "error", error: String(err) });
      } finally {
        guard?.dispose();
        releaseTaskRun?.();
        clearCronJobActive(jobId, activeJobMarker);
      }
    })().catch((err: unknown) => {
      // Last-resort guard: pre-run setup (config read, session-key resolution)
      // threw outside the announce path; a dropped dispatch must stay loggable.
      logHooks.warn(`hook agent dispatch failed: ${String(err)}`);
    });

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
