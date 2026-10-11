import { randomUUID } from "node:crypto";
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { listAgentIds } from "../../agents/agent-scope.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../../auto-reply/reply/session-event-handoff.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CronAgentAdmissionDisposition,
  RunCronAgentTurnResult,
} from "../../cron/isolated-agent/run.types.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import type { CronExecutionIdentityAdmission } from "../../cron/service/state.js";
import type { DeferredHookWake } from "../../cron/service/wake.js";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  normalizeHookDispatchSessionKey,
} from "../hooks.js";
import type { HookAgentCompletion, HookAgentDispatchResult } from "../hooks.types.js";
import {
  createScheduledGatewayRunner,
  fenceScheduledGatewayContextResolver,
} from "../scheduled-run-gateway-context.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import {
  createHookWakeDispatcher,
  deferHookEvent,
  resolveHookEventTarget,
  type HookEventTarget,
} from "./hooks-event-dispatch.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AGENT_START_ADMISSION_TIMEOUT_MS = 15_000;
const HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR =
  "hook agent run did not start before admission timeout";
const HOOK_AGENT_SESSION_CONFLICT_ERROR =
  "hook agent run was rejected because the target session changed";
const HOOK_AGENT_PREPARATION_ERROR = "hook agent run failed before entering the agent runner";

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

function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return truncateUtf16Safe(withoutControlChars.replace(/\s+/gu, " ").trim(), 500);
}

type HookLogMetadata = Record<string, string | boolean | undefined>;

function sanitizeHookLogMetadata(meta: HookLogMetadata): HookLogMetadata {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        // Redact the raw field first: truncation or folding a multiline secret can defeat masking.
        typeof value === "string"
          ? sanitizeHookConsoleValue(redactToolPayloadText(value).replace(/\p{Cc}/gu, " "))
          : value,
      ]),
  );
}

function createHookAdmissionFailure(params: {
  runId: string;
  disposition?: CronAgentAdmissionDisposition;
  statusCode?: 409 | 502 | 503;
}): HookAgentDispatchResult {
  const statusCode = params.statusCode ?? (params.disposition === "session-conflict" ? 409 : 502);
  return {
    ok: false,
    statusCode,
    error:
      statusCode === 409
        ? HOOK_AGENT_SESSION_CONFLICT_ERROR
        : statusCode === 503
          ? HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR
          : HOOK_AGENT_PREPARATION_ERROR,
    runId: params.runId,
  };
}

function createSessionKeyedHookDispatchQueue() {
  const hookAgentDispatchTails = new Map<string, Promise<void>>();

  return (sessionKey: string, operation: () => Promise<void>) => {
    const previousTail = hookAgentDispatchTails.get(sessionKey);
    const run = previousTail ? previousTail.catch(() => undefined).then(operation) : operation();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    hookAgentDispatchTails.set(sessionKey, tail);
    // Same-session hook agent runs append to one agent session. Serializing avoids
    // optimistic lifecycle-claim races while preserving parallelism across sessions.
    void tail.finally(() => {
      if (hookAgentDispatchTails.get(sessionKey) === tail) {
        hookAgentDispatchTails.delete(sessionKey);
      }
    });
    return run;
  };
}

async function validateHookAgentDeliveryAccount(params: {
  cfg: OpenClawConfig;
  value: HookAgentDispatchPayload;
}): Promise<HookAgentDispatchPayload> {
  // Mapped hooks can defer partial/last targets to cron and cannot select an account.
  // Bind only direct hook announces whose destination is already complete.
  if (
    params.value.delivery.mode !== "announce" ||
    params.value.delivery.channel === "last" ||
    !params.value.delivery.to
  ) {
    return params.value;
  }
  const accountId = params.value.delivery.accountId
    ? await validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: params.value.delivery.channel,
        accountId: params.value.delivery.accountId,
      })
    : (() => {
        const plugin = resolveOutboundChannelPlugin({
          channel: params.value.delivery.channel,
          cfg: params.cfg,
        });
        if (!plugin) {
          throw new Error(`Channel ${params.value.delivery.channel} is unavailable.`);
        }
        return resolveChannelDefaultAccountId({ plugin, cfg: params.cfg });
      })();
  if (!accountId) {
    throw new Error(`Channel ${params.value.delivery.channel} did not resolve an account.`);
  }
  return {
    ...params.value,
    accountId,
    delivery: { ...params.value.delivery, accountId },
  };
}

type PluginHookDispatch = PluginRuntime["hooks"]["dispatchHookAgentTurn"];
type PluginHookDispatchParams = Parameters<PluginHookDispatch>[0];
type PluginHookDispatchResult = Awaited<ReturnType<PluginHookDispatch>>;

/** Creates one lifecycle-owned dispatcher shared by HTTP hooks and trusted plugins. */
export function createGatewayHookDispatcher(params: {
  deps: CliDeps;
  logHooks: SubsystemLogger;
  agentStartAdmissionTimeoutMs?: number;
  deferHookWake?: DeferredHookWake;
  /**
   * Hook agent dispatch runs off a session-keyed queue, so the inbound HTTP
   * request scope is already unwound by the time the turn starts. Without this
   * the run is contextless and trusted built-in tools fail mid-run.
   */
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
}) {
  const {
    deps,
    logHooks,
    resolveGatewayContext,
    agentStartAdmissionTimeoutMs = HOOK_AGENT_START_ADMISSION_TIMEOUT_MS,
  } = params;
  const scheduledGatewayContextResolver =
    fenceScheduledGatewayContextResolver(resolveGatewayContext);
  const runScheduledHook = createScheduledGatewayRunner(scheduledGatewayContextResolver);
  const enqueueHookAgentDispatch = createSessionKeyedHookDispatchQueue();
  const announcedFailureReplays = new Map<string, number>();
  const claimFailureNotice = (replayKey: string | undefined) => {
    if (!replayKey) {
      return true;
    }
    const now = Date.now();
    for (const [key, announcedAt] of announcedFailureReplays) {
      if (announcedAt < now - DEDUPE_TTL_MS) {
        announcedFailureReplays.delete(key);
      }
    }
    if (announcedFailureReplays.has(replayKey)) {
      return false;
    }
    announcedFailureReplays.set(replayKey, now);
    pruneMapToMaxSize(announcedFailureReplays, DEDUPE_MAX);
    return true;
  };
  let isolatedAgentModulePromise:
    | Promise<typeof import("../../cron/isolated-agent.js")>
    | undefined;
  const loadIsolatedAgentModule = () =>
    (isolatedAgentModulePromise ??= import("../../cron/isolated-agent.js"));

  const dispatchWakeHook = createHookWakeDispatcher((outcome) => {
    logHooks.warn(
      "hook wake failed",
      sanitizeHookLogMetadata({ status: outcome.status, error: outcome.error }),
    );
  }, params.deferHookWake);

  const dispatchAgentHook = async (
    value: HookAgentDispatchPayload,
    pluginId?: string,
  ): Promise<HookAgentDispatchResult> => {
    const sessionKey = value.sessionKey;
    // A hook name is a single-line label: it lands in logs, in cron job `name` fields,
    // and inside prompt-bound system-event text. Reuse the console sanitizer so control
    // characters and line breaks cannot reshape any of those surfaces.
    const safeName = sanitizeHookConsoleValue(value.name) ?? "Hook";
    const jobId = randomUUID();
    const runId = randomUUID();
    const completion = createDeferredCore<HookAgentCompletion>();
    const logContext = sanitizeHookLogMetadata({
      runId,
      jobId,
      sourcePath: value.sourcePath,
      name: value.name,
      agentId: value.effectiveAgentId,
      logicalSessionKey: sessionKey,
    });
    const logHookRunTerminal = (result: RunCronAgentTurnResult) => {
      const meta = {
        ...logContext,
        ...sanitizeHookLogMetadata({
          status: result.status,
          sessionId: result.sessionId,
          sessionKey: result.sessionKey,
          deliver: value.deliver,
          delivered: result.delivered,
          deliveryAttempted: result.deliveryAttempted,
          deliveryError: result.deliveryError,
          deliverySuppressionReason: result.deliverySuppressionReason,
          model: result.model ?? value.model,
          summary: result.status !== "ok" ? resolveHookRunSummary(result) : undefined,
        }),
      };
      const details = ["runId", "status", "deliveryError", "summary", "model"].flatMap((key) =>
        meta[key] === undefined ? [] : [`${key}=${String(meta[key])}`],
      );
      // Log readers render the persisted message, not metadata or console-only overrides.
      const message = truncateUtf16Safe(["hook agent run completed", ...details].join(" "), 500);
      // A delivery error is separate from execution status; missing acknowledgments are not failures.
      const level = result.status !== "ok" || result.deliveryError ? "warn" : "info";
      logHooks[level](message, meta);
      return {
        status: result.status,
        replyDisposition: result.replyDisposition ?? "empty",
        ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
        ...(result.deliveryAttempted !== undefined
          ? { deliveryAttempted: result.deliveryAttempted }
          : {}),
        ...(result.deliveryError ? { deliveryError: "delivery-failed" as const } : {}),
        ...(result.deliverySuppressionReason
          ? { deliverySuppressionReason: result.deliverySuppressionReason }
          : {}),
      };
    };
    const nowMs = resolveDateTimestampMs(Date.now());
    const job: CronJob = {
      id: jobId,
      agentId: value.effectiveAgentId,
      name: safeName,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: resolveTimestampMsToIsoString(nowMs) },
      sessionTarget: value.sessionMode === "persistent" ? `session:${sessionKey}` : "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery: value.delivery,
      state: { nextRunAtMs: nowMs },
    };
    let hookEventTarget: HookEventTarget | undefined;
    const resolveGlobalTerminalAgentId = (status: string): string | undefined => {
      const acceptedAgentId = hookEventTarget?.agentId;
      // Agent id is the stable principal: mutable config reloads preserve admission,
      // but a principal absent from the fresh roster cannot receive terminal output.
      if (acceptedAgentId && listAgentIds(getRuntimeConfig()).includes(acceptedAgentId)) {
        return acceptedAgentId;
      }
      logHooks.warn("hook agent terminal event suppressed", {
        ...logContext,
        ...sanitizeHookLogMetadata({ acceptedAgentId, status }),
        reason: "accepted-agent-removed",
      });
      return undefined;
    };
    const announceHookEvent = async (
      eventTarget: HookEventTarget,
      text: string,
      status: string,
    ) => {
      if (status !== "ok" && !claimFailureNotice(value.replayKey)) {
        return;
      }
      try {
        const eventSessionKey = eventTarget.eventSessionKey;
        const isGlobalEvent = isUnscopedSessionKeySentinel(eventSessionKey);
        let eventAgentId = eventTarget.agentId;
        if (isGlobalEvent && hookEventTarget) {
          const globalTerminalAgentId = resolveGlobalTerminalAgentId(status);
          if (!globalTerminalAgentId) {
            return;
          }
          eventAgentId = globalTerminalAgentId;
        }
        const expectedTarget =
          eventTarget.expectedTarget ??
          (hookEventTarget
            ? undefined
            : await captureSessionEventTargetForHost(eventAgentId, eventSessionKey));
        if (!expectedTarget) {
          throw new Error("Hook terminal target could not be captured before the run");
        }
        if (value.wakeMode === "next-heartbeat") {
          await deferHookEvent(params.deferHookWake, {
            text,
            agentId: eventAgentId,
            expectedTarget,
            createIfMissing: true,
            commitGuard: () => {
              if (!listAgentIds(getRuntimeConfig()).includes(eventAgentId)) {
                throw new Error("Hook terminal agent was removed before event admission");
              }
            },
          });
          return;
        }
        const receipt = enqueueSessionEventForHost(text, {
          agentId: eventAgentId,
          sessionKey: eventSessionKey,
          source: "hook",
          expectedTarget,
          createIfMissing: true,
        });
        void receipt.settled.then((outcome) => {
          if (outcome.status !== "completed") {
            logHooks.warn("hook terminal event not delivered", {
              ...logContext,
              ...sanitizeHookLogMetadata({ status: outcome.status, error: outcome.error }),
            });
          }
        });
      } catch (error) {
        logHooks.warn("hook terminal event not delivered", {
          ...logContext,
          ...sanitizeHookLogMetadata({ error: formatErrorMessage(error) }),
        });
      }
    };
    const reportHookFailure = async (err: unknown) => {
      completion.resolve(logHookRunTerminal({ status: "error", error: String(err) }));
      try {
        await announceHookEvent(
          hookEventTarget ??
            resolveHookEventTarget({
              cfg: getRuntimeConfig(),
              resolvedAgentId: value.effectiveAgentId,
            }),
          `Hook ${safeName} (error): ${String(err)}`,
          "error",
        );
      } catch (reportError) {
        logHooks.warn("hook terminal event not delivered", {
          ...logContext,
          ...sanitizeHookLogMetadata({ error: formatErrorMessage(reportError) }),
        });
      }
    };
    let dispatchCfg: OpenClawConfig;
    try {
      dispatchCfg = getRuntimeConfig();
    } catch (err) {
      void runWithGatewayDetachedWorkContinuation(
        async () => reportHookFailure(err),
        "hooks:failure-report",
      );
      return createHookAdmissionFailure({ runId });
    }
    let acceptedValue: HookAgentDispatchPayload;
    try {
      acceptedValue = await validateHookAgentDeliveryAccount({ cfg: dispatchCfg, value });
      job.delivery = acceptedValue.delivery;
    } catch (err) {
      return {
        ok: false,
        statusCode: 400,
        error: formatErrorMessage(err),
        runId,
      };
    }
    const agentId = acceptedValue.effectiveAgentId;
    const queueKey = resolveCronAgentSessionKey({
      sessionKey,
      agentId,
      mainKey: dispatchCfg.session?.mainKey,
      cfg: dispatchCfg,
    });
    const admission = createDeferredCore<HookAgentDispatchResult>();
    let admissionSettled = false;
    let admissionTimedOut = false;
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    const settleAdmission = (result: HookAgentDispatchResult) => {
      if (admissionSettled) {
        return;
      }
      admissionSettled = true;
      if (admissionTimer) {
        clearTimeout(admissionTimer);
        admissionTimer = undefined;
      }
      if (result.ok && value.replayKey) {
        announcedFailureReplays.delete(value.replayKey);
      }
      admission.resolve(result);
    };
    const failAdmission = async (err: unknown) => {
      if (admissionTimedOut) {
        return;
      }
      settleAdmission(createHookAdmissionFailure({ runId }));
      await reportHookFailure(err);
    };
    const admissionTimeoutError = new Error(HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR);
    const startupAbortController = new AbortController();
    const settleSuccessfulAdmission = () => {
      startupAbortController.signal.throwIfAborted();
      settleAdmission({ ok: true, runId, completion: completion.promise });
    };
    // Background admission (fan-out items) skips the start deadline: the
    // producer's redelivery plus the replay cache own retry semantics, and a
    // canceled slow admission would keep every redelivery equally cold.
    if (value.admissionMode !== "background") {
      admissionTimer = setTimeout(() => {
        admissionTimedOut = true;
        startupAbortController.abort(admissionTimeoutError);
        settleAdmission(
          createHookAdmissionFailure({
            runId,
            statusCode: 503,
          }),
        );
      }, agentStartAdmissionTimeoutMs);
      admissionTimer.unref?.();
    }

    // Queue identity is fixed when accepted; the isolated runner still receives
    // the original session expression and fresh config, preserving hook routing.
    void runWithGatewayDetachedWorkContinuation(
      () =>
        enqueueHookAgentDispatch(queueKey, async () => {
          // The admission deadline starts before this same-session queue. Expired
          // work must never enter cron preparation after an HTTP 503 was returned.
          if (startupAbortController.signal.aborted) {
            return;
          }
          try {
            const cfg = getRuntimeConfig();
            try {
              await validateHookAgentDeliveryAccount({ cfg, value: acceptedValue });
            } catch (err) {
              settleAdmission({
                ok: false,
                statusCode: 400,
                error: formatErrorMessage(err),
                runId,
              });
              return;
            }
            if (startupAbortController.signal.aborted) {
              return;
            }
            // The accepted agent is the stable owner. Global scope stays global;
            // other events keep that owner in their agent-qualified session key.
            const eventTarget = resolveHookEventTarget({
              cfg,
              resolvedAgentId: agentId,
            });
            hookEventTarget = eventTarget;
            eventTarget.expectedTarget = await captureSessionEventTargetForHost(
              eventTarget.agentId,
              eventTarget.eventSessionKey,
            );
            const { runCronIsolatedAgentTurn } = await loadIsolatedAgentModule();
            // Lazy module loading is the last Gateway-owned async boundary before
            // cron preparation, so recheck the deadline after it settles.
            if (startupAbortController.signal.aborted) {
              return;
            }
            const runHookIsolatedTurn = async () =>
              await runCronIsolatedAgentTurn({
                cfg,
                deps,
                job,
                deliveryAttemptFence: null,
                message: acceptedValue.message,
                sessionKey,
                // Isolated runs derive their lifecycle key from random jobId (or an
                // already-stable cron: key), so accepted agentId closes reload drift.
                agentId,
                // Only HTTP hooks own the opt-in reserved lane. Trusted plugin
                // triggers share cron capacity even when the HTTP surface is off.
                lane: pluginId ? CommandLane.CronNested : CommandLane.HookDispatch,
                executionIdentity: {
                  ingress: pluginId
                    ? {
                        kind: "webhook",
                        boundary: "gateway.hooks.plugin",
                        state: "present",
                        rawSourceRef: `${pluginId}:${safeName}`,
                      }
                    : {
                        kind: "webhook",
                        boundary: "gateway.hooks.agent",
                        state: "present",
                        ...(acceptedValue.mappingId
                          ? { rawSourceRef: acceptedValue.mappingId }
                          : {}),
                      },
                } satisfies CronExecutionIdentityAdmission,
                abortSignal: startupAbortController.signal,
                onLaneWait: (info) => {
                  if (info?.stage === "execution" && info.waiting === false) {
                    settleSuccessfulAdmission();
                  }
                },
                onExecutionStarted: settleSuccessfulAdmission,
              });
            const result = await runScheduledHook(runHookIsolatedTurn);
            if (admissionTimedOut) {
              return;
            }
            const summary = resolveHookRunSummary(result);
            if (!admissionSettled) {
              settleAdmission(
                result.status === "ok" || result.executionStarted === true
                  ? { ok: true, runId, completion: completion.promise }
                  : createHookAdmissionFailure({
                      runId,
                      disposition: result.admissionDisposition,
                    }),
              );
            }
            const prefix =
              result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
            const shouldAnnounce =
              result.status !== "ok" ||
              (value.deliver && result.delivered !== true && result.deliveryAttempted !== true);
            completion.resolve(logHookRunTerminal(result));
            if (shouldAnnounce) {
              await announceHookEvent(eventTarget, `${prefix}: ${summary}`.trim(), result.status);
            }
          } catch (err) {
            await failAdmission(err);
          }
        }),
      "hooks:agent-dispatch",
    ).catch(failAdmission);

    return await admission.promise;
  };

  const pluginHookReplays = new Map<
    string,
    { createdAt: number; result: Promise<PluginHookDispatchResult> }
  >();
  const dispatchHookAgentTurn = async (
    value: PluginHookDispatchParams,
    pluginId: string,
  ): Promise<PluginHookDispatchResult> => {
    const agentId = normalizeOptionalString(value.agentId);
    if (!agentId) {
      return { ok: false, reason: "agentId is required" };
    }
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: agentId,
    });
    if (
      sessionKey !== value.sessionKey ||
      !sessionKey.startsWith("hook:") ||
      sessionKey.length <= 5 ||
      /[\s\p{Cc}]/u.test(sessionKey)
    ) {
      return {
        ok: false,
        reason: "sessionKey must start with hook: and contain no whitespace or control characters",
      };
    }
    if (value.externalContentSource !== "email") {
      return { ok: false, reason: "externalContentSource must be email" };
    }
    const run = async (): Promise<PluginHookDispatchResult> => {
      const result = await dispatchAgentHook(
        {
          name: value.name,
          agentId,
          effectiveAgentId: agentId,
          sessionKey,
          message: value.message,
          deliver: value.deliver,
          model: value.model,
          thinking: value.thinking,
          timeoutSeconds: value.timeoutSeconds,
          idempotencyKey: value.idempotencyKey,
          sessionMode: "isolated",
          sourcePath: `plugin:${pluginId}`,
          wakeMode: "now",
          channel: "last",
          delivery: value.deliver ? { mode: "announce", channel: "last" } : { mode: "none" },
          externalContentSource: "email",
        },
        pluginId,
      );
      return result.ok ? { ok: true, runId: result.runId } : { ok: false, reason: result.error };
    };
    const idempotencyKey = normalizeOptionalString(value.idempotencyKey);
    if (!idempotencyKey) {
      return await run();
    }
    const now = Date.now();
    for (const [key, entry] of pluginHookReplays) {
      if (entry.createdAt < now - DEDUPE_TTL_MS) {
        pluginHookReplays.delete(key);
      }
    }
    const replayKey = JSON.stringify({
      pluginId,
      idempotencyKey,
      name: value.name,
      agentId,
      sessionKey,
      message: value.message,
      externalContentSource: value.externalContentSource,
      deliver: value.deliver,
      model: value.model,
      thinking: value.thinking,
      timeoutSeconds: value.timeoutSeconds,
    });
    const replay = pluginHookReplays.get(replayKey);
    if (replay) {
      return await replay.result;
    }
    const result = run().then(
      (outcome) => {
        if (!outcome.ok) {
          pluginHookReplays.delete(replayKey);
        }
        return outcome;
      },
      (error: unknown) => {
        pluginHookReplays.delete(replayKey);
        throw error;
      },
    );
    pluginHookReplays.set(replayKey, { createdAt: now, result });
    pruneMapToMaxSize(pluginHookReplays, DEDUPE_MAX);
    return await result;
  };

  return { dispatchWakeHook, dispatchAgentHook, dispatchHookAgentTurn };
}

export type GatewayHookDispatcher = ReturnType<typeof createGatewayHookDispatcher>;

/** Creates the HTTP handler used by gateway hook endpoints. */
export function createGatewayHooksRequestHandler(params: {
  scheduler: GatewayScheduler;
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
  agentStartAdmissionTimeoutMs?: number;
  deferHookWake?: DeferredHookWake;
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
  dispatcher?: GatewayHookDispatcher;
}) {
  const { getHooksConfig, bindHost, port, logHooks, getClientIpConfig } = params;
  const { dispatchAgentHook, dispatchWakeHook } =
    params.dispatcher ?? createGatewayHookDispatcher(params);
  return createHooksRequestHandler({
    scheduler: params.scheduler,
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
