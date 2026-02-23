import { runSubagentAnnounceFlow } from "../../agents/subagent-announce.js";
import { countActiveDescendantRuns } from "../../agents/subagent-registry.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { logDebug, logWarn } from "../../logger.js";
import type { CronDeliveryOutcomeReason, CronJob, CronRunTelemetry } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.js";
import {
  expectsSubagentFollowup,
  isLikelyInterimCronMessage,
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.js";

function normalizeDeliveryTarget(channel: string, to: string): string {
  const channelLower = channel.trim().toLowerCase();
  const toTrimmed = to.trim();
  if (channelLower === "feishu" || channelLower === "lark") {
    const lowered = toTrimmed.toLowerCase();
    if (lowered.startsWith("user:")) {
      return toTrimmed.slice("user:".length).trim();
    }
    if (lowered.startsWith("chat:")) {
      return toTrimmed.slice("chat:".length).trim();
    }
  }
  return toTrimmed;
}

export function matchesMessagingToolDeliveryTarget(
  target: { provider?: string; to?: string; accountId?: string },
  delivery: { channel?: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  // Strip :topic:NNN from message targets and normalize Feishu/Lark prefixes on
  // both sides so cron duplicate suppression compares canonical IDs.
  const normalizedTargetTo = normalizeDeliveryTarget(channel, target.to.replace(/:topic:\d+$/, ""));
  const normalizedDeliveryTo = normalizeDeliveryTarget(channel, delivery.to);
  return normalizedTargetTo === normalizedDeliveryTo;
}

export function resolveCronDeliveryBestEffort(job: CronJob): boolean {
  if (typeof job.delivery?.bestEffort === "boolean") {
    return job.delivery.bestEffort;
  }
  if (job.payload.kind === "agentTurn" && typeof job.payload.bestEffortDeliver === "boolean") {
    return job.payload.bestEffortDeliver;
  }
  return false;
}

async function resolveCronAnnounceSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  fallbackSessionKey: string;
  delivery: {
    channel: NonNullable<DeliveryTargetResolution["channel"]>;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
}): Promise<string> {
  const to = params.delivery.to?.trim();
  if (!to) {
    return params.fallbackSessionKey;
  }
  try {
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.delivery.channel,
      agentId: params.agentId,
      accountId: params.delivery.accountId,
      target: to,
      threadId: params.delivery.threadId,
    });
    const resolved = route?.sessionKey?.trim();
    if (route && resolved) {
      // Ensure the session entry exists so downstream announce / queue delivery
      // can look up channel metadata (lastChannel, to, sessionId).  Named agents
      // may not have a session entry for this target yet, causing announce
      // delivery to silently fail (#32432).
      await ensureOutboundSessionEntry({
        cfg: params.cfg,
        agentId: params.agentId,
        channel: params.delivery.channel,
        accountId: params.delivery.accountId,
        route,
      }).catch(() => {
        // Best-effort: don't block delivery on session entry creation.
      });
      return resolved;
    }
  } catch {
    // Fall back to main session routing if announce session resolution fails.
  }
  return params.fallbackSessionKey;
}

export type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

type DispatchCronDeliveryParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runSessionId: string;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  deliveryRequested: boolean;
  skipHeartbeatDelivery: boolean;
  skipMessagingToolDelivery: boolean;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  summary?: string;
  outputText?: string;
  telemetry?: CronRunTelemetry;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  abortReason: () => string;
  withRunSession: (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ) => RunCronAgentTurnResult;
};

export type DispatchCronDeliveryState = {
  result?: RunCronAgentTurnResult;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryOutcomeReason?: CronDeliveryOutcomeReason;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
};

export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  // `true` means we confirmed at least one outbound send reached the target.
  // Keep this strict so timer fallback can safely decide whether to wake main.
  let delivered = params.skipMessagingToolDelivery;
  let deliveryAttempted = params.skipMessagingToolDelivery;
  // Tracks whether `runSubagentAnnounceFlow` was actually called.  Early
  // returns from `deliverViaAnnounce` (active subagents, interim suppression,
  // SILENT_REPLY_TOKEN) are intentional suppressions — not delivery failures —
  // so the direct-delivery fallback must only fire when the announce send was
  // actually attempted and failed.
  let announceDeliveryWasAttempted = false;
  let deliveryOutcomeReason: CronDeliveryOutcomeReason | undefined = !params.deliveryRequested
    ? "not-requested"
    : params.skipMessagingToolDelivery
      ? "messaging-tool-delivered"
      : params.skipHeartbeatDelivery
        ? "heartbeat-only"
        : undefined;
  const withDeliveryOutcome = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
    reason: CronDeliveryOutcomeReason,
  ): RunCronAgentTurnResult => {
    return params.withRunSession({ ...result, deliveryAttempted, deliveryOutcomeReason: reason });
  };
  const markDeliveryOutcome = (reason: CronDeliveryOutcomeReason): void => {
    deliveryOutcomeReason = reason;
  };
  const failDeliveryTarget = (error: string) => {
    markDeliveryOutcome("target-resolution-failed");
    return withDeliveryOutcome(
      {
        status: "error",
        error,
        errorKind: "delivery-target",
        summary,
        outputText,
        ...params.telemetry,
      },
      "target-resolution-failed",
    );
  };

  const deliverViaDirect = async (
    delivery: SuccessfulDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    try {
      const payloadsForDelivery =
        deliveryPayloads.length > 0
          ? deliveryPayloads
          : synthesizedText
            ? [{ text: synthesizedText }]
            : [];
      if (payloadsForDelivery.length === 0) {
        markDeliveryOutcome("no-deliverable-payload");
        return null;
      }
      if (params.isAborted()) {
        return withDeliveryOutcome(
          {
            status: "error",
            error: params.abortReason(),
            ...params.telemetry,
          },
          "direct-send-failed",
        );
      }
      deliveryAttempted = true;
      const deliverySession = buildOutboundSessionContext({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        sessionKey: params.agentSessionKey,
      });
      const deliveryResults = await deliverOutboundPayloads({
        cfg: params.cfgWithAgentDefaults,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        payloads: payloadsForDelivery,
        session: deliverySession,
        identity,
        bestEffort: params.deliveryBestEffort,
        deps: createOutboundSendDeps(params.deps),
        abortSignal: params.abortSignal,
      });
      delivered = deliveryResults.length > 0;
      markDeliveryOutcome(delivered ? "direct-delivered" : "direct-send-failed");
      return null;
    } catch (err) {
      if (!params.deliveryBestEffort) {
        return withDeliveryOutcome(
          {
            status: "error",
            summary,
            outputText,
            error: String(err),
            ...params.telemetry,
          },
          "direct-send-failed",
        );
      }
      markDeliveryOutcome("direct-send-failed");
      return null;
    }
  };

  const deliverViaAnnounce = async (
    delivery: SuccessfulDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (!synthesizedText) {
      markDeliveryOutcome("no-deliverable-payload");
      return null;
    }
    const announceMainSessionKey = resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const announceSessionKey = await resolveCronAnnounceSessionKey({
      cfg: params.cfgWithAgentDefaults,
      agentId: params.agentId,
      fallbackSessionKey: announceMainSessionKey,
      delivery: {
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
      },
    });
    const taskLabel =
      typeof params.job.name === "string" && params.job.name.trim()
        ? params.job.name.trim()
        : `cron:${params.job.id}`;
    const initialSynthesizedText = synthesizedText.trim();
    let activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
    const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
    const hadActiveDescendants = activeSubagentRuns > 0;
    if (activeSubagentRuns > 0 || expectedSubagentFollowup) {
      let finalReply = await waitForDescendantSubagentSummary({
        sessionKey: params.agentSessionKey,
        initialReply: initialSynthesizedText,
        timeoutMs: params.timeoutMs,
        observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
      });
      activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
      if (
        !finalReply &&
        activeSubagentRuns === 0 &&
        (hadActiveDescendants || expectedSubagentFollowup)
      ) {
        finalReply = await readDescendantSubagentFallbackReply({
          sessionKey: params.agentSessionKey,
          runStartedAt: params.runStartedAt,
        });
      }
      if (finalReply && activeSubagentRuns === 0) {
        outputText = finalReply;
        summary = pickSummaryFromOutput(finalReply) ?? summary;
        synthesizedText = finalReply;
        deliveryPayloads = [{ text: finalReply }];
      }
    }
    if (activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // update to the main requester.
      return withDeliveryOutcome(
        { status: "ok", summary, outputText, ...params.telemetry },
        "subagent-still-running",
      );
    }
    if (
      (hadActiveDescendants || expectedSubagentFollowup) &&
      synthesizedText.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      initialSynthesizedText.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase()
    ) {
      // Descendants existed but no post-orchestration synthesis arrived, so
      // suppress stale parent text like "on it, pulling everything together".
      return withDeliveryOutcome(
        { status: "ok", summary, outputText, ...params.telemetry },
        "interim-suppressed",
      );
    }
    if (synthesizedText.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
      return withDeliveryOutcome(
        {
          status: "ok",
          summary,
          outputText,
          delivered: true,
          ...params.telemetry,
        },
        "silent-reply",
      );
    }
    try {
      if (params.isAborted()) {
        return withDeliveryOutcome(
          {
            status: "error",
            error: params.abortReason(),
            ...params.telemetry,
          },
          "announce-failed",
        );
      }
      deliveryAttempted = true;
      announceDeliveryWasAttempted = true;
      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: params.agentSessionKey,
        childRunId: `${params.job.id}:${params.runSessionId}:${params.runStartedAt}`,
        requesterSessionKey: announceSessionKey,
        requesterOrigin: {
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
        },
        requesterDisplayKey: announceSessionKey,
        task: taskLabel,
        timeoutMs: params.timeoutMs,
        cleanup: params.job.deleteAfterRun ? "delete" : "keep",
        roundOneReply: synthesizedText,
        // Cron output is a finished completion message: send it directly to the
        // target channel via the completion-direct-send path rather than injecting
        // a trigger message into the (likely idle) main agent session.
        expectsCompletionMessage: true,
        // Keep delivery outcome truthful for cron state: if outbound send fails,
        // announce flow must report false so caller can apply best-effort policy.
        bestEffortDeliver: false,
        waitForCompletion: false,
        startedAt: params.runStartedAt,
        endedAt: params.runEndedAt,
        outcome: { status: "ok" },
        announceType: "cron job",
        signal: params.abortSignal,
      });
      if (didAnnounce) {
        delivered = true;
        markDeliveryOutcome("announce-delivered");
      } else {
        // Announce delivery failed but the agent execution itself succeeded.
        // Return ok so the job isn't penalized for a transient delivery issue
        // (e.g. "pairing required" when no active client session exists).
        // Delivery failure is tracked separately via delivered/deliveryAttempted.
        const message = "cron announce delivery failed";
        logWarn(`[cron:${params.job.id}] ${message}`);
        if (!params.deliveryBestEffort) {
          return withDeliveryOutcome(
            {
              status: "error",
              summary,
              outputText,
              error: message,
              ...params.telemetry,
            },
            "announce-failed",
          );
        }
        markDeliveryOutcome("announce-failed");
        logWarn(`[cron:${params.job.id}] ${message}`);
      }
    } catch (err) {
      // Same as above: announce delivery errors should not mark a successful
      // agent execution as failed.
      logWarn(`[cron:${params.job.id}] ${String(err)}`);
      if (!params.deliveryBestEffort) {
        return withDeliveryOutcome(
          {
            status: "error",
            summary,
            outputText,
            error: String(err),
            ...params.telemetry,
          },
          "announce-failed",
        );
      }
      markDeliveryOutcome("announce-failed");
      logWarn(`[cron:${params.job.id}] ${String(err)}`);
    }
    return null;
  };

  if (
    params.deliveryRequested &&
    !params.skipHeartbeatDelivery &&
    !params.skipMessagingToolDelivery
  ) {
    if (!params.resolvedDelivery.ok) {
      if (!params.deliveryBestEffort) {
        return {
          result: failDeliveryTarget(params.resolvedDelivery.error.message),
          delivered,
          deliveryAttempted,
          deliveryOutcomeReason,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
      logWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      markDeliveryOutcome("target-resolution-failed-best-effort");
      return {
        result: withDeliveryOutcome(
          {
            status: "ok",
            summary,
            outputText,
            ...params.telemetry,
          },
          "target-resolution-failed-best-effort",
        ),
        delivered,
        deliveryAttempted,
        deliveryOutcomeReason,
        summary,
        outputText,
        synthesizedText,
        deliveryPayloads,
      };
    }

    // Route text-only cron announce output back through the main session so it
    // follows the same system-message injection path as subagent completions.
    // Keep direct outbound delivery only for structured payloads (media/channel
    // data), which cannot be represented by the shared announce flow.
    //
    // Forum/topic targets should also use direct delivery. Announce flow can
    // be swallowed by ANNOUNCE_SKIP/NO_REPLY in the target agent turn, which
    // silently drops cron output for topic-bound sessions.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirect(params.resolvedDelivery);
      if (directResult) {
        return {
          result: directResult,
          delivered,
          deliveryAttempted,
          deliveryOutcomeReason: directResult.deliveryOutcomeReason ?? deliveryOutcomeReason,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
    } else {
      const announceResult = await deliverViaAnnounce(params.resolvedDelivery);
      if (announceResult) {
        // Fall back to direct delivery only when the announce send was
        // actually attempted and failed.  Early returns from
        // deliverViaAnnounce (active subagents, interim suppression,
        // SILENT_REPLY_TOKEN) are intentional suppressions that must NOT
        // trigger direct delivery — doing so would bypass the suppression
        // guard and leak partial/stale content to the channel.  (#32432)
        if (announceDeliveryWasAttempted && !delivered && !params.isAborted()) {
          const directFallback = await deliverViaDirect(params.resolvedDelivery);
          if (directFallback) {
            return {
              result: directFallback,
              delivered,
              deliveryAttempted,
              summary,
              outputText,
              synthesizedText,
              deliveryPayloads,
            };
          }
          // If direct delivery succeeded (returned null without error),
          // `delivered` has been set to true by deliverViaDirect.
          if (delivered) {
            return {
              delivered,
              deliveryAttempted,
              summary,
              outputText,
              synthesizedText,
              deliveryPayloads,
            };
          }
        }
        return {
          result: announceResult,
          delivered,
          deliveryAttempted,
          deliveryOutcomeReason: announceResult.deliveryOutcomeReason ?? deliveryOutcomeReason,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
    }
  }

  if (params.deliveryRequested && !deliveryOutcomeReason && !delivered) {
    markDeliveryOutcome("no-deliverable-payload");
  }
  logDebug(
    `[cron:${params.job.id}] delivery outcome requested=${params.deliveryRequested} ` +
      `delivered=${delivered} reason=${deliveryOutcomeReason ?? "none"} ` +
      `heartbeatSkip=${params.skipHeartbeatDelivery} messagingToolSkip=${params.skipMessagingToolDelivery} ` +
      `bestEffort=${params.deliveryBestEffort}`,
  );
  return {
    delivered,
    deliveryAttempted,
    deliveryOutcomeReason,
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
  };
}
