import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resetRegisteredAgentHarnessSessions } from "../agents/harness/registry.js";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-state.js";
import { isHeartbeatAcknowledgementText } from "../auto-reply/heartbeat.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { getRuntimeConfig } from "../config/config.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { resolveActiveSessionRunId } from "../sessions/session-controller.queries.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { formatErrorMessage } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import { resolveHeartbeatForWake, type HeartbeatConfig } from "./heartbeat-config.js";
import {
  isExecCompletionSystemEvent,
  isRestartContinuationEvent,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import { shouldUseHeartbeatResponseToolPrompt } from "./heartbeat-runner-config.js";
import { resolveHeartbeatPreflight, resolveHeartbeatRunPrompt } from "./heartbeat-runner-prompt.js";
import {
  type HeartbeatSessionSelection,
  resolveStaleHeartbeatIsolatedSessionKey,
} from "./heartbeat-runner-session.js";
import { isHeartbeatEnabledForAgent, resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  inferHeartbeatWakeSourceFromReason,
  isConfiguredHeartbeatAgent,
  isTargetedUnscheduledWake,
} from "./heartbeat-wake-policy.js";
import {
  areHeartbeatsEnabled,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeIntent,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import {
  resolveHeartbeatDeliveryTargetWithSessionRoute,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("../auto-reply/reply/get-reply.js").getReplyFromConfig;
    nowMs?: () => number;
  };

function skippedHeartbeatStage<T extends string>(reason: T, startedAt: number) {
  emitHeartbeatEvent({
    status: "skipped",
    reason,
    durationMs: Date.now() - startedAt,
  });
  return { kind: "skipped", reason } as const;
}

export type HeartbeatRunOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatConfig;
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  /** Persisted monitor cadence carried by a coalesced scheduled wake. */
  scheduledEveryMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  deps?: HeartbeatDeps;
};

export async function resolveHeartbeatWakeStage(opts: HeartbeatRunOptions) {
  const cfg = opts.cfg ?? getRuntimeConfig();
  const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
  const forcedSessionAgentId =
    explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;
  const resolvedAgentId =
    explicitAgentId || forcedSessionAgentId || tryResolveAmbientHeartbeatAgentId(cfg);
  if (!resolvedAgentId) {
    return { kind: "skipped", reason: "disabled" } as const;
  }
  const agentId = normalizeAgentId(resolvedAgentId);
  const wakeSource = opts.source ?? inferHeartbeatWakeSourceFromReason(opts.reason);
  const heartbeat = resolveHeartbeatForWake({
    cfg,
    agentId,
    requestedHeartbeat: opts.heartbeat,
    source: wakeSource,
  });
  const scheduledTasks = [...(opts.tasks ?? [])].toSorted((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
  const allowsUnscheduledTarget =
    isTargetedUnscheduledWake(opts) && isConfiguredHeartbeatAgent(cfg, agentId);
  if (
    !areHeartbeatsEnabled() ||
    (!allowsUnscheduledTarget &&
      (!isHeartbeatEnabledForAgent(cfg, agentId) ||
        !resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)))
  ) {
    return { kind: "skipped", reason: "disabled" } as const;
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  // Cron uses the heartbeat runner as execution transport; heartbeat scheduling windows do not own it.
  if (
    !allowsUnscheduledTarget &&
    wakeSource !== "cron" &&
    !isWithinActiveHours(cfg, heartbeat, startedAt)
  ) {
    // Documented observable skip (`system heartbeat last` / troubleshooting
    // docs promise reason=quiet-hours); every sibling skip past this point
    // emits, so a silent return here hides the window from operators.
    return skippedHeartbeatStage("quiet-hours", startedAt);
  }

  // Resolve the physical target and its pending events before considering recovery fences.
  const preflight = await resolveHeartbeatPreflight({
    ...opts,
    cfg,
    agentId,
    heartbeat,
    source: wakeSource,
    scheduledTasks,
  });
  if (preflight.skipReason) {
    return skippedHeartbeatStage(preflight.skipReason, startedAt);
  }

  // Plain `updatedAt` changes are normal for heartbeat sessions and should not
  // suppress heartbeat runs; only defer when final delivery recovery is active.
  const { sessionKey: recentSessionKey, entry: recentSessionEntry } = preflight.session;
  // Recovery can already have admitted its owner and cleared the abort flag;
  // automatic and sentinel wakes must honor that canonical lifecycle fence.
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const mainSessionRecovery =
    opts.intent !== "manual" && recentSessionEntry
      ? transitionMainSessionRecovery(recentSessionEntry, {
          kind: "inspect",
          lifecycleGeneration,
          sessionKey: recentSessionKey,
        })
      : undefined;
  const activeRestartRecoveryRunId = normalizeOptionalString(
    recentSessionEntry?.restartRecoveryDeliveryRunId,
  );
  // Delivery ownership can outlive the recovery aggregate. Only the matching
  // run from this gateway generation may defer an automatic heartbeat.
  const hasCurrentRestartRecoveryDelivery =
    opts.intent !== "manual" &&
    activeRestartRecoveryRunId !== undefined &&
    recentSessionEntry?.restartRecoveryRuns?.some(
      (run) =>
        run.runId === activeRestartRecoveryRunId && run.lifecycleGeneration === lifecycleGeneration,
    ) === true;
  if (
    (mainSessionRecovery?.kind === "observed" &&
      (mainSessionRecovery.view.status === "blocked" ||
        mainSessionRecovery.view.status === "recoverable")) ||
    hasCurrentRestartRecoveryDelivery
  ) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
  }
  const HEARTBEAT_DEFER_WINDOW_MS = 30_000;
  const pendingFinalDeliveryText =
    recentSessionEntry?.pendingFinalDelivery?.kind === "replayable"
      ? recentSessionEntry.pendingFinalDelivery.text
      : undefined;
  const pendingFinalDeliveryIsHeartbeatAck =
    typeof pendingFinalDeliveryText === "string" &&
    isHeartbeatAcknowledgementText(pendingFinalDeliveryText);
  if (
    recentSessionEntry?.pendingFinalDelivery !== undefined &&
    !pendingFinalDeliveryIsHeartbeatAck &&
    recentSessionEntry?.updatedAt &&
    startedAt - recentSessionEntry.updatedAt < HEARTBEAT_DEFER_WINDOW_MS
  ) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
  }

  return {
    kind: "ready",
    cfg,
    agentId,
    wakeSource,
    heartbeat,
    scheduledTasks,
    isAmbientPoll:
      (wakeSource === undefined || wakeSource === "interval") &&
      (opts.intent === undefined || opts.intent === "scheduled") &&
      preflight.pendingEventEntries.length === 0 &&
      scheduledTasks.length === 0,
    startedAt,
    preflight,
  } as const;
}

type StageResult<T, K extends string> = Extract<Awaited<T>, { kind: K }>;
export type ReadyHeartbeatWake = StageResult<ReturnType<typeof resolveHeartbeatWakeStage>, "ready">;

export async function prepareHeartbeatRunStage(wake: ReadyHeartbeatWake) {
  const { cfg, agentId, heartbeat, preflight } = wake;
  const { scheduledTasks, startedAt } = wake;
  const { entry, sessionKey, run, conversationEntry } = preflight.session;
  const previousUpdatedAt = entry?.updatedAt;
  const projectionSessionKey = run.kind === "isolated" ? run.baseSessionKey : sessionKey;
  // Capture the client-owned generation before routing can await. The inspected
  // completion queue owns publication eligibility, not the coalesced wake source.
  // Session-owned work: a background command completion, or the continuation of a turn
  // interrupted by a Gateway restart. Both answer the session that owns them.
  const isSessionOwnedEvent = (event: (typeof preflight.pendingEventEntries)[number]) =>
    isExecCompletionSystemEvent(event) ||
    (wake.wakeSource === "restart-sentinel" && isRestartContinuationEvent(event));
  const projectionCandidate =
    scheduledTasks.length === 0 &&
    preflight.shouldInspectPendingEvents &&
    preflight.pendingEventEntries.some(isSessionOwnedEvent) &&
    !preflight.session.suppressOriginatingContext &&
    !isInternalSessionEffectsKey(projectionSessionKey) &&
    conversationEntry?.delivery?.kind === "internal" &&
    conversationEntry.createdVia !== "internal" &&
    (conversationEntry.createdVia === "operator" ||
      conversationEntry.lastReadAt !== undefined ||
      (conversationEntry.createdVia === "spawn" &&
        parseAgentSessionKey(projectionSessionKey)?.rest.startsWith("dashboard:")))
      ? {
          sessionKey: projectionSessionKey,
          sessionId: conversationEntry.sessionId,
          lifecycleRevision: conversationEntry.lifecycleRevision,
        }
      : undefined;

  // When isolatedSession is enabled, create a fresh session via the same
  // pattern as cron sessionTarget: "isolated". This gives the heartbeat
  // a new session ID (empty transcript) each run, avoiding the cost of
  // sending the full conversation history (~100K tokens) to the LLM.
  // Delivery routing uses the selected conversation, not the fresh execution row.
  const execOwnsRoute =
    preflight.shouldInspectPendingEvents &&
    scheduledTasks.length === 0 &&
    preflight.turnSourceDeliveryContext !== undefined &&
    preflight.selectedEventEntries.some(isExecCompletionSystemEvent);
  const resolveDeliveryFor = (
    selection: HeartbeatSessionSelection,
    heartbeatPolicy: typeof heartbeat,
    turnSourceKind?: "exec",
  ) =>
    resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId,
      entry: selection.conversationEntry,
      heartbeat: heartbeatPolicy,
      currentSessionKey: sessionKey,
      // A base queue's route stays excluded; events on the actual isolated queue
      // own their route, including exec completion after the base route moves.
      turnSource:
        turnSourceKind === "exec" || selection.inspectsRunQueue
          ? preflight.turnSourceDeliveryContext
          : undefined,
      ...(turnSourceKind ? { turnSourceKind } : {}),
    });
  // The heartbeat target, recipient and direct-chat policy govern heartbeat output.
  // A conversation's own command completion answers in that conversation.
  const resolvedDelivery = await resolveDeliveryFor(
    preflight.session,
    preflight.conversationRoute ? { target: "last" } : heartbeat,
    execOwnsRoute ? "exec" : undefined,
  );
  // Operator-chosen suppression is the resolver's verdict, not a config string:
  // an explicit target that never resolves to a route also reports `target-none`.
  // Gate here so neither the relay prompt nor the session publication path can
  // see a projection target the resolver already declined to deliver to.
  const internalProjection =
    resolvedDelivery.reason === "target-none" ||
    (execOwnsRoute && !isInternalMessageChannel(preflight.turnSourceDeliveryContext?.channel))
      ? undefined
      : projectionCandidate;
  // Session-owned work in an internal session (the same eligibility as the routeless
  // projection above: Control UI/WebChat and other operator-owned internal sessions)
  // answers in that session. The heartbeat target is for heartbeat output and must not
  // capture it. Mixed batches keep the resolved route for their other events. If the
  // session write fails, the events stay queued for a later wake; there is no channel
  // fallback.
  const sessionOwnedCompletion =
    internalProjection !== undefined &&
    preflight.pendingEventEntries.length > 0 &&
    preflight.pendingEventEntries.every(isSessionOwnedEvent);
  const delivery: typeof resolvedDelivery = sessionOwnedCompletion
    ? { ...resolvedDelivery, channel: "none", to: undefined, reason: "session-owned-completion" }
    : resolvedDelivery;
  // Routeless ambient polls are pure model burn, but only they may skip:
  // triggered wakes (hook/manual/cron/exec), polls with queued events, and
  // scheduled-task wakes must still run to process their payloads even when
  // the reply cannot deliver. An absent source is the plain scheduled poll.
  if (delivery.channel === "none" && delivery.reason === "no-route" && wake.isAmbientPoll) {
    return skippedHeartbeatStage("no-route", startedAt);
  }
  const heartbeatAccountId = heartbeat?.accountId?.trim();
  if (delivery.reason === "unknown-account") {
    log.warn("heartbeat: unknown accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId ?? null,
      target: heartbeat?.target ?? "owner",
    });
  } else if (heartbeatAccountId) {
    log.info("heartbeat: using explicit accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId,
      target: heartbeat?.target ?? "owner",
      channel: delivery.channel,
    });
  }
  // A continuation is the conversation's reply: channel heartbeat toggles govern polls,
  // and a quiet outcome stays quiet.
  const visibility =
    delivery.channel === "none" || preflight.conversationRoute
      ? { showOk: false, showAlerts: true, useIndicator: true }
      : resolveHeartbeatVisibility({
          cfg,
          channel: delivery.channel,
          accountId: delivery.accountId,
        });
  // The continuation authorizes the model's reply, not host-generated notices (failure
  // notices, tool warnings): those keep the heartbeat target, isolation and alert toggle
  // that governed them (#153573).
  const heartbeatDelivery = preflight.conversationRoute
    ? await resolveDeliveryFor(preflight.heartbeatSession, heartbeat)
    : undefined;
  const quietHostNotices =
    heartbeatDelivery !== undefined &&
    (heartbeatDelivery.channel === "none" ||
      !heartbeatDelivery.to ||
      !resolveHeartbeatVisibility({
        cfg,
        channel: heartbeatDelivery.channel,
        accountId: heartbeatDelivery.accountId,
      }).showAlerts);
  const { sender } = await resolveHeartbeatSenderContext({ cfg, entry, delivery });
  const replyPrefix = createReplyPrefixContext({
    cfg,
    agentId,
    channel: delivery.channel !== "none" ? delivery.channel : undefined,
    accountId: delivery.accountId,
  });
  const canRelayToUser =
    visibility.showAlerts &&
    ((delivery.channel !== "none" && Boolean(delivery.to)) || internalProjection !== undefined);
  const usesResponseTool = (sessionEntry: typeof entry, targetSessionKey: string) =>
    shouldUseHeartbeatResponseToolPrompt({
      cfg,
      agentId,
      heartbeat,
      entry: sessionEntry,
      sessionKey: targetSessionKey,
      chatType: delivery.chatType,
    });
  const useHeartbeatResponseToolPrompt = usesResponseTool(entry, sessionKey);
  const resolveRunPrompt = (useHeartbeatResponseTool: boolean) =>
    resolveHeartbeatRunPrompt({
      cfg,
      heartbeat,
      preflight,
      canRelayToUser,
      scheduledTasks,
      useHeartbeatResponseTool,
    });
  let heartbeatRunPrompt = resolveRunPrompt(useHeartbeatResponseToolPrompt);

  const runSessionKey = run.sessionKey;
  let runSessionEntry = entry;
  let outboundPolicySessionKey: string | undefined;
  if (run.kind === "isolated") {
    const { sessionKey: isolatedSessionKey, baseSessionKey: isolatedBaseSessionKey } = run;
    const isolatedStorePath = preflight.session.storePath;
    // The follow-up still needs the legacy row's explicit base binding for its original queue.
    const staleIsolatedSessionKey =
      preflight.deferredEventEntries.length > 0 ||
      (heartbeatRunPrompt.hasExecCompletion && heartbeatRunPrompt.hasCronEvents)
        ? undefined
        : resolveStaleHeartbeatIsolatedSessionKey({
            sessionKey,
            isolatedSessionKey,
            isolatedBaseSessionKey,
          });
    if (
      resolveActiveSessionRunId(
        isolatedSessionKey,
        captureSessionTarget({
          storeScope: isolatedStorePath,
          sessionKey: isolatedSessionKey,
          agentId,
        }),
      )
    ) {
      return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
    }
    const staleIsolatedEntry = staleIsolatedSessionKey
      ? await readSessionEntryReadOnlyInWorker({
          agentId,
          storePath: isolatedStorePath,
          sessionKey: staleIsolatedSessionKey,
        })
      : undefined;
    // Keep usage/transcript lineage without adopting the predecessor's native thread.
    // As with ordinary rollovers, reset the harness before replacing the entry.
    const isolatedEntry = await readSessionEntryReadOnlyInWorker({
      agentId,
      storePath: isolatedStorePath,
      sessionKey: isolatedSessionKey,
    });
    if (isolatedEntry?.sessionId) {
      await resetRegisteredAgentHarnessSessions({
        agentId,
        sessionId: isolatedEntry.sessionId,
        sessionKey: isolatedSessionKey,
        sessionFile: isolatedSessionKey,
        reason: "new",
      });
    }
    const removals: SessionEntryLifecycleRemoval[] = staleIsolatedSessionKey
      ? [
          {
            sessionKey: staleIsolatedSessionKey,
            ...(staleIsolatedEntry ? { expectedEntry: staleIsolatedEntry } : {}),
            ...(staleIsolatedEntry?.sessionId
              ? { expectedSessionId: staleIsolatedEntry.sessionId }
              : {}),
            archiveRemovedTranscript: true,
          },
        ]
      : [];
    const lifecycleResult = await applySessionEntryLifecycleMutation({
      agentId,
      activeSessionKey: isolatedSessionKey,
      storePath: isolatedStorePath,
      removals,
      upserts: [
        {
          // Seed next-user context only for conversation bases, never absent transient cron runs.
          sessionKey: isolatedBaseSessionKey,
          buildEntry: ({ currentEntry, sessionKey: baseSessionKey }) =>
            currentEntry || isCronRunSessionKey(baseSessionKey)
              ? undefined
              : mergeSessionEntry(undefined, { updatedAt: startedAt }),
        },
        {
          sessionKey: isolatedSessionKey,
          buildEntry: ({ currentEntry }) => {
            const cronSession = resolveCronSession({
              cfg,
              sessionKey: isolatedSessionKey,
              agentId,
              nowMs: startedAt,
              forceNew: true,
              lifecycleTimestamps: {},
              store: currentEntry ? { [isolatedSessionKey]: currentEntry } : {},
            });
            const nextEntry = {
              ...cronSession.sessionEntry,
              heartbeatIsolatedBaseSessionKey: isolatedBaseSessionKey,
            };
            runSessionEntry = nextEntry;
            return nextEntry;
          },
        },
      ],
      captureArtifactCleanupError: true,
    });
    if (lifecycleResult.artifactCleanupError) {
      log.warn("heartbeat: failed to archive stale isolated session transcript", {
        err: formatErrorMessage(lifecycleResult.artifactCleanupError),
        sessionKey: staleIsolatedSessionKey,
      });
    }
    outboundPolicySessionKey = isolatedBaseSessionKey;

    const actualUseHeartbeatResponseToolPrompt = usesResponseTool(runSessionEntry, runSessionKey);
    if (actualUseHeartbeatResponseToolPrompt !== useHeartbeatResponseToolPrompt) {
      heartbeatRunPrompt = resolveRunPrompt(actualUseHeartbeatResponseToolPrompt);
    }
  }
  return {
    kind: "ready",
    ...preflight.session,
    previousUpdatedAt,
    policySessionEntry:
      outboundPolicySessionKey && (outboundPolicySessionKey !== sessionKey || !entry)
        ? await readSessionEntryReadOnlyInWorker({
            agentId,
            storePath: preflight.session.storePath,
            sessionKey: outboundPolicySessionKey,
          })
        : entry,
    delivery,
    visibility,
    canRelayToUser,
    sender,
    replyPrefix,
    runSessionKey,
    outboundPolicySessionKey,
    internalProjection,
    quietHostNotices,
    ...heartbeatRunPrompt,
    // Selected work outranks a coalesced wake; periodic tasks own their prompt even on an exec wake.
    useHeartbeatFailureCopy:
      scheduledTasks.length > 0 ||
      (!heartbeatRunPrompt.hasTaskContinuation &&
        !heartbeatRunPrompt.hasCronEvents &&
        (wake.wakeSource === undefined ||
          wake.wakeSource === "interval" ||
          wake.wakeSource === "manual")),
    // Session publication owns restart custody through commit, not prompt admission.
    deferredGenericEvents:
      internalProjection && delivery.channel === "none"
        ? heartbeatRunPrompt.genericEvents.filter(isRestartContinuationEvent)
        : [],
  } as const;
}

export type PreparedHeartbeatRun = StageResult<
  ReturnType<typeof prepareHeartbeatRunStage>,
  "ready"
>;
