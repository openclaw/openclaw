import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { markChannelMirrorCapable } from "./channel-mirror-capability.js";
import { createMirrorReplyResolver } from "./echo-mirror-resolver.js";
import { normalizeEchoTargetId, resolveEchoTargets } from "./echo.js";

const log = createSubsystemLogger("outbound/mirror-dispatch");

/**
 * Channel-agnostic pin-from-here mirror.
 *
 * One agent run; its parsed event stream is broadcast on the agent-event bus by
 * runId. For each pinned echo target we hand that target's OWN channel dispatch a
 * bus-sourced `replyResolver` (createMirrorReplyResolver) instead of letting it
 * call the agent. The target channel then renders + persists the turn through its
 * normal pipeline — so streaming, drafts, formatting, and persistence all follow
 * THAT channel's own config (streaming on → it streams; off → final only). No
 * per-channel rendering is reimplemented; each channel registers only a thin
 * dispatcher that re-homes the turn onto its inbound path.
 *
 * Loop/duplicate safety: a mirror turn is a render of an already-mirrored turn,
 * not an origin turn. It must not re-enter echo. It skips the agent-run fan-out by
 * construction (the replyResolver replaces the agent), AND the channel dispatch
 * suppresses the mirror turn's `message:sent` internal hook (it carries a
 * replyResolver), so it does not re-trigger the post-hoc echo and re-deliver to the
 * other pinned threads.
 */
export type MirrorDispatcher = (params: {
  cfg: OpenClawConfig;
  target: SessionEchoTarget;
  /** Drives the mirrored turn from the origin run's bus; replaces the model. */
  replyResolver: GetReplyFromConfig;
  sessionKey?: string;
}) => Promise<void> | void;

export type MirrorDispatchHandle = {
  /** Number of targets a mirror turn was launched for. */
  count: number;
  /** Detach all bus subscriptions (origin turn aborted before any consumed them). */
  dispose: () => void;
};

const state = {
  // channel -> accountId -> dispatcher. Account-keyed (not channel-only) so a
  // multi-account install mirrors through the TARGET account's own runtime — its
  // bot token, routing, and persistence — never the first-registered account's.
  dispatchers: new Map<string, Map<string, MirrorDispatcher>>(),
  /** sessionKey -> target keys a mirror turn was launched for this run. */
  handledBySession: new Map<string, Set<string>>(),
};

function normalizeDispatcherAccountId(accountId: string | undefined): string {
  return accountId && accountId.trim() ? accountId : "";
}

function echoTargetKey(target: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}): string {
  return [
    target.channel,
    normalizeEchoTargetId(target.channel, target.to),
    target.accountId ?? "",
    target.threadId ?? "",
  ].join("|");
}

function markHandled(sessionKey: string | undefined, key: string): void {
  if (!sessionKey) {
    return;
  }
  let set = state.handledBySession.get(sessionKey);
  if (!set) {
    set = new Set();
    state.handledBySession.set(sessionKey, set);
  }
  set.add(key);
}

function unmarkHandled(sessionKey: string | undefined, key: string): void {
  if (!sessionKey) {
    return;
  }
  const set = state.handledBySession.get(sessionKey);
  if (set?.delete(key) && set.size === 0) {
    state.handledBySession.delete(sessionKey);
  }
}

/**
 * Consume the "mirror handled this target" mark. The post-hoc final echo
 * (fireEchoDeliveries) calls this to SKIP targets a mirror turn already rendered
 * natively, so the two don't double-deliver. Single-use: clears the mark.
 */
export function consumeStreamingEchoHandled(
  sessionKey: string | undefined,
  target: { channel: string; to: string; accountId?: string; threadId?: string | number },
): boolean {
  if (!sessionKey) {
    return false;
  }
  const set = state.handledBySession.get(sessionKey);
  if (!set) {
    return false;
  }
  if (!set.delete(echoTargetKey(target))) {
    return false;
  }
  if (set.size === 0) {
    state.handledBySession.delete(sessionKey);
  }
  return true;
}

/**
 * Register the mirror dispatcher for a channel ACCOUNT. A channel plugin
 * registers one dispatcher per account it serves (the dispatcher closes over
 * that account's bot/runtime), so a mirror to a given target renders through the
 * target's own account.
 *
 * Re-registration REPLACES the previous dispatcher (last-wins). The dispatcher
 * captures a live bot instance, so when an account is reloaded/restarted in-process
 * its bot-core re-registers — the new dispatcher must supersede the old one, or
 * mirrors would keep routing through the stopped runtime (stale token/bot).
 */
export function registerChannelMirrorDispatcher(
  channel: string,
  accountId: string,
  dispatcher: MirrorDispatcher,
): void {
  const key = normalizeDispatcherAccountId(accountId);
  let byAccount = state.dispatchers.get(channel);
  if (!byAccount) {
    byAccount = new Map<string, MirrorDispatcher>();
    state.dispatchers.set(channel, byAccount);
  }
  const existing = byAccount.get(key);
  if (existing && existing !== dispatcher) {
    log.debug(
      `mirror dispatcher for ${channel}/${key || "default"} replaced (account re-registered)`,
    );
  }
  byAccount.set(key, dispatcher);
  // Sticky: once a channel is mirror-capable, the echo-admission gate must keep
  // failing closed for it even while its admission predicate is briefly absent
  // (stop/reload unregisters the dispatcher AND the predicate together).
  markChannelMirrorCapable(channel);
}

/**
 * Remove the mirror dispatcher for a channel account (called when an account stops
 * so a removed account does not keep a stale dispatcher). No-op if absent.
 */
export function unregisterChannelMirrorDispatcher(channel: string, accountId: string): void {
  const byAccount = state.dispatchers.get(channel);
  if (!byAccount) {
    return;
  }
  byAccount.delete(normalizeDispatcherAccountId(accountId));
  if (byAccount.size === 0) {
    state.dispatchers.delete(channel);
  }
}

/**
 * Whether the channel supports native mirroring at all (any account registered a
 * dispatcher). Used to fail closed: for a mirror-capable channel, the native mirror
 * is the SOLE delivery authority — the post-hoc raw echo must not deliver there
 * because it bypasses the channel's enablement/revocation checks.
 */
export function channelHasMirrorDispatcher(channel: string): boolean {
  const byAccount = state.dispatchers.get(channel);
  return byAccount !== undefined && byAccount.size > 0;
}

/**
 * Resolve the dispatcher for a target's (channel, account). An exact account match
 * is always preferred. A WILDCARD target — one with no pinned accountId — may use
 * the sole registered dispatcher (single-account install). But a target that pins
 * an EXPLICIT account which does not match fails closed (returns undefined) even
 * when only one account is registered: a mirror must never render through a
 * different account than the one the target pinned. On a miss the post-hoc final
 * echo handles the target via its own account routing.
 */
export function resolveChannelMirrorDispatcher(
  channel: string,
  accountId?: string,
): MirrorDispatcher | undefined {
  const byAccount = state.dispatchers.get(channel);
  if (!byAccount || byAccount.size === 0) {
    return undefined;
  }
  const key = normalizeDispatcherAccountId(accountId);
  const exact = byAccount.get(key);
  if (exact) {
    return exact;
  }
  // Sole-dispatcher fallback ONLY for a wildcard target (no pinned account).
  if (key === "" && byAccount.size === 1) {
    return [...byAccount.values()][0];
  }
  return undefined;
}

/**
 * Launch a mirror turn on each pinned echo target. Must run BEFORE the origin run
 * emits — the bus has no replay buffer, so each target's resolver subscribes
 * synchronously here (createMirrorReplyResolver) and queues events until the
 * target's dispatch invokes it.
 */
export async function launchMirrorDispatch(params: {
  originRunId: string;
  cfg: OpenClawConfig;
  sessionKey?: string;
  sessionEntry: SessionEntry | undefined;
  originChannel: string;
  originTo: string;
  originAccountId?: string;
  originThreadId?: string | number;
}): Promise<MirrorDispatchHandle> {
  const targets = resolveEchoTargets(params.sessionEntry, {
    originChannel: params.originChannel,
    originTo: params.originTo,
    originAccountId: params.originAccountId,
    originThreadId: params.originThreadId,
    role: "assistant",
  });

  // Clear the previous run's marks for this session before re-marking what THIS
  // run mirrors (turns are serialized per session, so the prior run's post-hoc has
  // already consumed its marks).
  if (params.sessionKey) {
    state.handledBySession.delete(params.sessionKey);
  }

  const active: Array<{ dispose: () => void }> = [];
  for (const target of targets) {
    const dispatcher = resolveChannelMirrorDispatcher(target.channel, target.accountId);
    if (!dispatcher) {
      if (channelHasMirrorDispatcher(target.channel)) {
        // The channel supports native mirroring but no dispatcher resolved for this
        // target's account (account not registered, or a brief post-restart race).
        // FAIL CLOSED: mark handled so the post-hoc final echo does NOT deliver —
        // that raw send bypasses the channel's enablement/revocation checks, so it
        // could leak content to a now-disabled destination. The native mirror is the
        // sole delivery authority for a mirror-capable channel.
        markHandled(params.sessionKey, echoTargetKey(target));
        log.warn(
          `mirror: no dispatcher resolved for ${target.channel}/${target.accountId ?? "default"}; suppressing post-hoc echo (fail closed)`,
        );
        continue;
      }
      // Channel does not support native mirroring at all — the post-hoc final echo
      // is its only delivery path.
      continue;
    }
    const label = `${target.channel}:${target.to}`;
    const targetKey = echoTargetKey(target);
    const { resolver, dispose } = createMirrorReplyResolver({
      originRunId: params.originRunId,
      targetLabel: label,
      ...(params.cfg.agents?.defaults?.toolProgressDetail
        ? { toolProgressDetail: params.cfg.agents.defaults.toolProgressDetail }
        : {}),
    });
    // Mark synchronously so the post-hoc final echo skips this target (the mirror
    // renders it) — the post-hoc fires after the origin run, so the mark must be
    // set before then. If the mirror dispatch fails (dispatcher throws / context
    // dropped / never renders), UN-mark so the post-hoc still delivers and the
    // target is not silently dropped.
    markHandled(params.sessionKey, targetKey);
    active.push({ dispose });
    // Fire-and-forget: a mirror turn must never block or abort the origin turn.
    void Promise.resolve(
      dispatcher({
        cfg: params.cfg,
        target,
        replyResolver: resolver as unknown as GetReplyFromConfig,
        sessionKey: params.sessionKey,
      }),
    ).catch((err: unknown) => {
      log.warn(`mirror dispatch failed for ${label}: ${formatErrorMessage(err)}`);
      unmarkHandled(params.sessionKey, targetKey);
      dispose();
    });
  }

  return {
    count: active.length,
    dispose: () => {
      for (const entry of active) {
        entry.dispose();
      }
    },
  };
}

export function resetMirrorDispatchForTest(): void {
  state.dispatchers.clear();
}
