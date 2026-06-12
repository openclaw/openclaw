import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
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
 * KNOWN LIMITATION (multiple pinned threads): a mirror turn runs the target's full
 * inbound pipeline, which emits `message:sent` and so re-enters the post-hoc echo
 * hook (echo-hook.ts). For a SINGLE pinned thread this is harmless — the mirror
 * turn's origin equals its only target, so resolveEchoTargets self-excludes it. But
 * with 2+ pinned threads, the mirror turn on thread B can post-hoc-re-deliver to
 * thread C (which the origin already mirrored natively), a bounded (not infinite —
 * fireEchoDeliveries is hook-suppressed) duplicate. A full fix marks the mirror
 * turn so the post-hoc hook skips it; tracked as follow-up.
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
  dispatchers: new Map<string, MirrorDispatcher>(),
  /** sessionKey -> target keys a mirror turn was launched for this run. */
  handledBySession: new Map<string, Set<string>>(),
};

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
 * Register the mirror dispatcher for a channel. First-wins, mirroring the
 * ownership contract of the channel registry: a channel plugin registers the
 * dispatcher for its OWN channel id, exactly once.
 */
export function registerChannelMirrorDispatcher(channel: string, dispatcher: MirrorDispatcher): void {
  const existing = state.dispatchers.get(channel);
  if (existing && existing !== dispatcher) {
    log.warn(`mirror dispatcher already registered for ${channel}; ignoring re-registration`);
    return;
  }
  state.dispatchers.set(channel, dispatcher);
}

export function resolveChannelMirrorDispatcher(channel: string): MirrorDispatcher | undefined {
  return state.dispatchers.get(channel);
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
    const dispatcher = resolveChannelMirrorDispatcher(target.channel);
    if (!dispatcher) {
      // No dispatcher for this channel — the post-hoc final mirror handles it.
      continue;
    }
    const label = `${target.channel}:${target.to}`;
    const targetKey = echoTargetKey(target);
    const { resolver, dispose } = createMirrorReplyResolver({
      originRunId: params.originRunId,
      targetLabel: label,
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
