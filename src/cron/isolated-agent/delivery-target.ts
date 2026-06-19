/** Resolves isolated cron delivery requests into concrete outbound targets. */
import { normalizeOptionalThreadValue } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveExplicitDeliveryTargetCompat } from "../../channels/plugins/target-parsing-loaded.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { stripTargetProviderPrefix } from "../../infra/outbound/channel-target-prefix.js";
import type { OutboundSessionRoute } from "../../infra/outbound/outbound-session.js";
import type { ResolvedMessagingTarget } from "../../infra/outbound/target-resolver.js";
import { tryResolveLoadedOutboundTarget } from "../../infra/outbound/targets-loaded.js";
import { resolveSessionDeliveryTarget } from "../../infra/outbound/targets-session.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { getActiveTaskRouteLease, updateTaskRouteLease } from "../../tasks/task-route-lease.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveCronStoredDeliveryContext } from "../delivery-context.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

/** Result of resolving a cron job delivery request into a sendable outbound channel target. */
export type DeliveryTargetResolution =
  | {
      ok: true;
      channel: Exclude<OutboundChannel, "none">;
      to: string;
      accountId?: string;
      threadId?: string | number;
      mode: "explicit" | "implicit";
    }
  | {
      ok: false;
      channel?: Exclude<OutboundChannel, "none">;
      to?: string;
      accountId?: string;
      threadId?: string | number;
      mode: "explicit" | "implicit";
      error: Error;
    };

const targetsRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/targets.runtime.js"),
);

async function loadTargetsRuntime() {
  return await targetsRuntimeLoader.load();
}

async function resolveOutboundTargetWithRuntime(
  params: Parameters<typeof tryResolveLoadedOutboundTarget>[0],
) {
  try {
    const loaded = tryResolveLoadedOutboundTarget(params);
    if (loaded) {
      return loaded;
    }
    const { resolveOutboundTarget } = await loadTargetsRuntime();
    return resolveOutboundTarget({ ...params, allowBootstrap: true });
  } catch (err) {
    return {
      ok: false as const,
      error: new Error(`Invalid delivery target: ${formatErrorMessage(err)}`),
    };
  }
}

const channelSelectionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/channel-selection.runtime.js"),
);
const deliveryTargetRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-target.runtime.js"),
);

async function loadChannelSelectionRuntime() {
  return await channelSelectionRuntimeLoader.load();
}

async function loadDeliveryTargetRuntime() {
  return await deliveryTargetRuntimeLoader.load();
}

function isNonEmptyThreadId(value: string | number | undefined | null): value is string | number {
  return value != null && value !== "";
}

function routesSharePeer(left?: OutboundSessionRoute | null, right?: OutboundSessionRoute | null) {
  return Boolean(
    left &&
    right &&
    left.baseSessionKey === right.baseSessionKey &&
    left.peer.kind === right.peer.kind &&
    left.peer.id === right.peer.id,
  );
}

function shouldCarrySessionThread(params: {
  resolved: ReturnType<typeof resolveSessionDeliveryTarget>;
  explicitTo?: string;
  route?: OutboundSessionRoute | null;
  lastRoute?: OutboundSessionRoute | null;
}) {
  if (!isNonEmptyThreadId(params.resolved.threadId)) {
    return false;
  }
  if (!params.explicitTo) {
    return (
      params.resolved.channel === params.resolved.lastChannel &&
      params.resolved.to === params.resolved.lastTo
    );
  }
  // Explicit targets may reuse a stored thread only when both targets resolve
  // to the same channel peer; otherwise cron could reply into a stale thread.
  return routesSharePeer(params.route, params.lastRoute);
}

function stripSelectedProviderPrefix(params: {
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
}): string | undefined {
  const trimmed = params.to?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = stripTargetProviderPrefix(trimmed, params.channel).trim();
  return stripped || undefined;
}

function shouldStripResolvedTargetProviderPrefix(target: ResolvedMessagingTarget): boolean {
  return target.resolutionSource === "normalized";
}

/**
 * Update the task-route lease for a run with the target the resolver
 * just produced. Best-effort: never throws; no-op when the lease is
 * missing, terminal, or the resolver produced no concrete target.
 *
 * Called by `resolveCronDeliveryContext` after `resolveDeliveryTarget`
 * returns ok:true (see #92460 P1 #2). The lease captured at
 * `tryCreateCronTaskRun` time may have only `channel` and no `to`; once
 * the resolver has produced a routable target, persisting it to the lease
 * lets the completion-time resolver recover the same target even when
 * the higher-precedence session sources have been evicted or retargeted
 * in the meantime.
 */
export function updateResolvedTaskRouteLease(params: {
  runId: string;
  resolved: Extract<DeliveryTargetResolution, { ok: true }>;
  now?: number;
}): boolean {
  if (!params.runId) {
    return false;
  }
  const origin: DeliveryContext = {
    channel: params.resolved.channel,
    to: params.resolved.to,
  };
  if (params.resolved.accountId) {
    origin.accountId = params.resolved.accountId;
  }
  if (params.resolved.threadId !== undefined && params.resolved.threadId !== null) {
    origin.threadId = params.resolved.threadId;
  }
  return updateTaskRouteLease(params.runId, origin, { now: params.now });
}

/**
 * #92460 P1 #3 helper: is a session entry a routable delivery candidate
 * given the caller-supplied explicit to and requested channel?
 *
 * An entry is "routable" when it carries a (channel, to) pair the resolver
 * can use without further fallback to a different source:
 *
 *  - `entry.deliveryContext` has a non-empty channel AND either a non-empty
 *    `to` or the caller has supplied `explicitTo`;
 *  - OR `requestedChannel === "last"` AND the entry remembered a
 *    `lastChannel`/`lastTo` pair (the resolver can use it for the "last"
 *    branch of `resolveSessionDeliveryTarget`).
 *
 * Presence alone is not enough — the reported case in #92460 is exactly
 * the case where the session entry exists without `deliveryContext` or
 * `lastTo`, and a presence-based `??` chain would let that empty entry
 * mask the routable task-route lease fallback.
 */
function isRoutableDeliveryEntry(
  entry: SessionEntry | undefined,
  params: { explicitTo?: string; requestedChannel: string },
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  const ctx = entry.deliveryContext;
  if (ctx?.channel) {
    if (ctx.to) {
      return true;
    }
    if (params.explicitTo) {
      return true;
    }
  }
  if (params.requestedChannel === "last" && entry.lastChannel && entry.lastTo) {
    return true;
  }
  return false;
}

/** Resolves cron delivery config into a concrete channel target and optional thread/account. */
export async function resolveDeliveryTarget(
  cfg: OpenClawConfig,
  agentId: string,
  jobPayload: {
    channel?: ChannelId;
    to?: string;
    threadId?: string | number;
    /** Explicit accountId from job.delivery — overrides session-derived and binding-derived values. */
    accountId?: string;
    sessionKey?: string;
    /**
     * Detached run id for the current cron run. When provided, the resolver
     * consults the task-route lease store as an additional fallback for the
     * outbound origin: if the originating session entry has been evicted or
     * the shared main session bucket was retargeted by another conversation
     * since the cron job was created, the lease carries the original
     * requester origin captured at job start (see #92460).
     */
    runId?: string;
  },
  options?: { dryRun?: boolean },
): Promise<DeliveryTargetResolution> {
  const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const allowMismatchedLastTo = requestedChannel === "last";
  const deliveryTargetRuntime = await loadDeliveryTargetRuntime();

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });

  // Look up thread-specific session first (e.g. agent:main:main:thread:1234),
  // then fall back to the main session entry.
  const rawSessionKey = jobPayload.sessionKey?.trim();
  const threadSessionKey = rawSessionKey
    ? resolveCronAgentSessionKey({
        sessionKey: rawSessionKey,
        agentId,
        mainKey: cfg.session?.mainKey,
        cfg,
      })
    : undefined;
  const storedDeliveryContext = resolveCronStoredDeliveryContext({
    cfg,
    sessionKey: threadSessionKey,
  });
  const storedDeliveryEntry = storedDeliveryContext
    ? ({
        sessionId: threadSessionKey ?? mainSessionKey,
        updatedAt: 0,
        deliveryContext: storedDeliveryContext,
      } satisfies SessionEntry)
    : undefined;
  const threadEntry = threadSessionKey
    ? loadSessionEntry({ agentId, sessionKey: threadSessionKey, storePath })
    : undefined;
  const mainEntry = loadSessionEntry({ agentId, sessionKey: mainSessionKey, storePath });
  // Task-route lease fallback for #92460: when the session-keyed lookups
  // miss (because the originating session entry is gone, the shared main
  // bucket is now another conversation's room, or no thread session exists),
  // an active lease on the run id carries the requester origin captured
  // at job start. Best-effort: lease lookup is read-only and never throws.
  const leaseOrigin = jobPayload.runId
    ? getActiveTaskRouteLease(jobPayload.runId)?.requesterOrigin
    : undefined;
  const leaseEntry: SessionEntry | undefined = leaseOrigin
    ? ({
        sessionId: threadSessionKey ?? mainSessionKey,
        updatedAt: 0,
        deliveryContext: leaseOrigin,
      } satisfies SessionEntry)
    : undefined;
  // #92460 P1 #1: routability-based fallback. The reported case is exactly
  // an isolated cron session entry that EXISTS but has no `deliveryContext`
  // / `lastTo` (no message has ever been routed through it). A presence-
  // based `??` chain treats that empty entry as authoritative and masks the
  // task-route lease, which is the only place the original outbound origin
  // survives. Prefer the first higher-precedence source that actually
  // resolves to a routable (channel, to) pair; fall through to the
  // presence-based chain ONLY when no source is routable, preserving the
  // existing "no target" / "no channel" error path.
  const fallbackCandidates: ReadonlyArray<SessionEntry | undefined> = [
    storedDeliveryEntry,
    threadEntry,
    leaseEntry,
    mainEntry,
  ];
  const routableCandidate = fallbackCandidates.find((entry) =>
    isRoutableDeliveryEntry(entry, {
      explicitTo,
      requestedChannel,
    }),
  );
  const main = routableCandidate ?? storedDeliveryEntry ?? threadEntry ?? leaseEntry ?? mainEntry;
  // True when the cron has no delivery identity of its own (no per-job
  // target, no own sessionKey, no routable stored/thread/lease entry) and
  // therefore fell back to the SHARED agent-main session bucket. See the
  // #91613 refusal below. The previous definition omitted `!threadEntry`
  // and used presence (not routability) for the higher-precedence sources;
  // both gaps masked the lease fallback in the reported #92460 case.
  const usedSharedMainFallback =
    main === mainEntry &&
    !isRoutableDeliveryEntry(storedDeliveryEntry, { explicitTo, requestedChannel }) &&
    !isRoutableDeliveryEntry(threadEntry, { explicitTo, requestedChannel }) &&
    !isRoutableDeliveryEntry(leaseEntry, { explicitTo, requestedChannel });

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
    explicitTo,
    explicitThreadId: jobPayload.threadId,
    allowMismatchedLastTo,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  let channelResolutionError: Error | undefined;
  if (!preliminary.channel) {
    if (preliminary.lastChannel) {
      fallbackChannel = preliminary.lastChannel;
    } else {
      try {
        const { resolveMessageChannelSelection } = await loadChannelSelectionRuntime();
        const selection = await resolveMessageChannelSelection({ cfg });
        fallbackChannel = selection.channel;
      } catch (err) {
        const detail = formatErrorMessage(err);
        channelResolutionError = new Error(
          `${detail} Set delivery.channel explicitly or use a main session with a previous channel.`,
        );
      }
    }
  }

  const resolved = fallbackChannel
    ? resolveSessionDeliveryTarget({
        entry: main,
        requestedChannel,
        explicitTo,
        explicitThreadId: jobPayload.threadId,
        fallbackChannel,
        allowMismatchedLastTo,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel;
  const mode = resolved.mode as "explicit" | "implicit";
  let toCandidate = resolved.to;

  // Prefer an explicit accountId from the job's delivery config (set via
  // --account on cron add/edit). Fall back to the session's lastAccountId,
  // then to the agent's bound account from bindings config.
  const explicitAccountId =
    typeof jobPayload.accountId === "string" && jobPayload.accountId.trim()
      ? jobPayload.accountId.trim()
      : undefined;
  let accountId = explicitAccountId ?? resolved.accountId;
  if (!accountId && channel) {
    accountId = deliveryTargetRuntime.resolveFirstBoundAccountId({
      cfg,
      channelId: channel,
      agentId,
    });
  }

  // job.delivery.accountId takes highest precedence — explicitly set by the job author.
  if (jobPayload.accountId) {
    accountId = jobPayload.accountId;
  }

  if (!channel) {
    return {
      ok: false,
      channel: undefined,
      to: undefined,
      accountId,
      threadId: undefined,
      mode,
      error:
        channelResolutionError ??
        new Error("Channel is required when delivery.channel=last has no previous channel."),
    };
  }

  const explicitThreadId = isNonEmptyThreadId(jobPayload.threadId)
    ? jobPayload.threadId
    : undefined;

  let effectiveAllowFrom: string[] | undefined;
  if (mode === "implicit") {
    const { getLoadedChannelPluginForRead, mapAllowFromEntries } = deliveryTargetRuntime;
    const channelPlugin = getLoadedChannelPluginForRead(channel);
    const resolvedAccountId = normalizeAccountId(accountId);
    const configuredAllowFromRaw = channelPlugin?.config.resolveAllowFrom?.({
      cfg,
      accountId: resolvedAccountId,
    });
    const configuredAllowFrom = configuredAllowFromRaw
      ? mapAllowFromEntries(configuredAllowFromRaw)
      : [];
    const allowFromOverride = uniqueStrings(configuredAllowFrom);
    effectiveAllowFrom = allowFromOverride;

    if (toCandidate && allowFromOverride.length > 0) {
      // Implicit delivery must stay within channel allow-from policy; if the
      // remembered target is outside that set, fall back to the first allowed peer.
      const currentTargetResolution = await resolveOutboundTargetWithRuntime({
        channel,
        to: toCandidate,
        cfg,
        accountId,
        mode,
        allowFrom: effectiveAllowFrom,
      });
      if (!currentTargetResolution.ok) {
        toCandidate = allowFromOverride[0];
      }
    }
  }

  // Issue #91613: refuse a KEYLESS implicit isolated cron whose delivery target was only inherited
  // from the SHARED agent-main session bucket's last recipient. That bucket is last-writer-wins
  // across every conversation the agent handles, so the inherited `lastTo` can be a different
  // conversation's room — the wrong room — which the durable delivery queue then replays verbatim
  // after a restart. Returning ok:false (instead of a separate flag callers must remember to check)
  // routes the refusal through the delivery dispatch !ok gate, the failure-notification path, and
  // the delivery preview alike: every consumer honors ok:false, the dispatch gate refuses the send
  // WITHOUT reaching the durable enqueue, so recovery replays nothing. (The agent turn still runs;
  // only delivery is refused, at the dispatch gate — there is no pre-execution preflight.) Narrowed:
  //   - keyless only (`!rawSessionKey`) — a cron with its own session key/target resolves via that
  //     session, not the shared bucket, so it is never refused here;
  //   - evaluated AFTER the allowFrom reroute above (`toCandidate === resolved.lastTo`) — a cron
  //     whose stale target was rerouted to a configured allow-from peer is delivering to that
  //     allowed peer, not the inherited room, so it is not refused.
  if (
    !rawSessionKey &&
    mode === "implicit" &&
    !explicitTo &&
    usedSharedMainFallback &&
    toCandidate != null &&
    toCandidate === resolved.lastTo
  ) {
    return {
      ok: false,
      channel,
      to: undefined,
      accountId,
      threadId: explicitThreadId,
      mode,
      error: new Error(
        "Refusing implicit isolated cron delivery: the target would be inherited from the shared " +
          "agent-main session bucket's last recipient, which is ambiguous across conversations and " +
          "can deliver to the wrong room (and replay there after a restart). Set delivery.channel " +
          "and delivery.to explicitly, or run the cron from a session that carries its own " +
          "delivery context.",
      ),
    };
  }

  const preResolvedRouteTargetCandidate = toCandidate;
  const docked = await resolveOutboundTargetWithRuntime({
    channel,
    to: toCandidate,
    cfg,
    accountId,
    mode,
    allowFrom: effectiveAllowFrom,
  });
  if (!docked.ok) {
    return {
      ok: false,
      channel,
      to: undefined,
      accountId,
      threadId: explicitThreadId,
      mode,
      error: docked.error,
    };
  }
  toCandidate = docked.to;
  const targetResolution = await deliveryTargetRuntime.resolveChannelTargetForDelivery({
    cfg,
    channel,
    input: toCandidate,
    accountId,
  });
  if (!targetResolution.ok) {
    return {
      ok: false,
      channel,
      to: undefined,
      accountId,
      threadId: explicitThreadId,
      mode,
      error: targetResolution.error,
    };
  }
  const resolvedTarget: ResolvedMessagingTarget | undefined = targetResolution.target;
  const routeTargetCandidate =
    resolvedTarget.source === "directory"
      ? resolvedTarget.to
      : (preResolvedRouteTargetCandidate ?? toCandidate);
  const selectedTarget = shouldStripResolvedTargetProviderPrefix(resolvedTarget)
    ? stripSelectedProviderPrefix({
        channel,
        to: resolvedTarget.to,
      })
    : resolvedTarget.to.trim();
  if (!selectedTarget) {
    return {
      ok: false,
      channel,
      to: undefined,
      accountId,
      threadId: explicitThreadId,
      mode,
      error: new Error("Target is required"),
    };
  }
  toCandidate = selectedTarget;

  const route = await (async () => {
    try {
      return await deliveryTargetRuntime.resolveOutboundSessionRouteForDelivery({
        cfg,
        channel,
        agentId,
        accountId,
        target: routeTargetCandidate,
        resolvedTarget,
        threadId: explicitThreadId,
        currentSessionKey: threadSessionKey ?? mainSessionKey,
      });
    } catch {
      return null;
    }
  })();
  const routeCanCanonicalizeTarget = deliveryTargetRuntime.channelCanResolveOutboundSessionRoute({
    cfg,
    channel,
  });
  const routeShouldCanonicalizeTarget =
    route && (route.threadId !== undefined || route.to !== routeTargetCandidate);
  if (route && routeCanCanonicalizeTarget && routeShouldCanonicalizeTarget) {
    // Prefer channel-canonical targets when the plugin can prove the route; this
    // keeps stored session keys and delivery targets aligned for threaded sends.
    const routeTo = stripSelectedProviderPrefix({
      channel,
      to: route.to,
    });
    if (!routeTo) {
      return {
        ok: false,
        channel,
        to: undefined,
        accountId,
        threadId: explicitThreadId,
        mode,
        error: new Error("Target is required"),
      };
    }
    toCandidate = routeTo;
  }
  const lastTo = resolved.lastTo;
  const lastRoute =
    lastTo && resolved.lastChannel === channel
      ? await (async () => {
          try {
            return await deliveryTargetRuntime.resolveOutboundSessionRouteForDelivery({
              cfg,
              channel,
              agentId,
              accountId: resolved.lastAccountId ?? accountId,
              target: lastTo,
              threadId: resolved.lastThreadId,
              currentSessionKey: threadSessionKey ?? mainSessionKey,
            });
          } catch {
            return null;
          }
        })()
      : null;

  const parserExplicitThreadId =
    explicitThreadId == null && explicitTo
      ? normalizeOptionalThreadValue(
          resolveExplicitDeliveryTargetCompat({
            channel,
            rawTarget: explicitTo,
          })?.threadId,
        )
      : undefined;
  // Thread precedence is explicit config, route canonicalization, parser-derived
  // explicit target, then same-peer session history.
  const threadId =
    explicitThreadId ??
    route?.threadId ??
    parserExplicitThreadId ??
    (shouldCarrySessionThread({
      resolved,
      explicitTo,
      route,
      lastRoute,
    })
      ? resolved.threadId
      : undefined);
  if (options?.dryRun) {
    return {
      ok: true,
      channel,
      to: toCandidate,
      accountId,
      threadId,
      mode,
    };
  }
  return {
    ok: true,
    channel,
    to: toCandidate,
    accountId,
    threadId,
    mode,
  };
}
