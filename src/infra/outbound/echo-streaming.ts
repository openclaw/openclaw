import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { createMirrorReplyResolver } from "./echo-mirror-resolver.js";
import { normalizeEchoTargetId, resolveEchoTargets } from "./echo.js";

const log = createSubsystemLogger("outbound/echo-streaming");

/**
 * B-full native streaming echo — channel-agnostic fan-out.
 *
 * A channel plugin registers an EchoRendererFactory; when an origin turn starts
 * with streaming-enabled echo targets, we create one mirror resolver
 * (echo-mirror-resolver.ts) + one channel renderer per target and let the
 * resolver replay the single agent run onto each target's native renderer. The
 * agent runs ONCE; each target renders live and natively. Returns undefined for a
 * target whose channel has no factory or whose streaming is disabled — those fall
 * back to the post-hoc final mirror (fireEchoDeliveries).
 */
export type ChannelEchoRenderer = {
  /** Driven by the mirror resolver to render the origin run on the target. */
  options: GetReplyOptions;
  /** Flush to final state when the origin run ends. */
  finalize: (final?: ReplyPayload) => Promise<void> | void;
  /** Abort without finalizing (origin turn aborted). */
  dispose: () => Promise<void> | void;
};

export type EchoRendererFactoryParams = {
  cfg: OpenClawConfig;
  target: SessionEchoTarget;
};

export type EchoRendererFactory = (
  params: EchoRendererFactoryParams,
) => Promise<ChannelEchoRenderer | undefined> | ChannelEchoRenderer | undefined;

type EchoStreamingState = {
  factories: Map<string, EchoRendererFactory>;
  /** sessionKey -> set of target keys already handled by a live renderer this turn. */
  handledBySession: Map<string, Set<string>>;
};

const state: EchoStreamingState = {
  factories: new Map(),
  handledBySession: new Map(),
};

/**
 * Register the streaming-echo renderer factory for a channel.
 *
 * Ownership contract: a channel plugin registers the factory for ITS OWN channel id,
 * exactly once (call from the channel's startup; idempotent re-registration with the
 * same factory is fine). Registration is FIRST-WINS — a different factory cannot
 * overwrite an already-registered channel — so a later/foreign caller cannot hijack
 * another channel's echo rendering. Subsequent conflicting registrations are ignored
 * with a warning rather than silently taking over.
 */
export function registerEchoRendererFactory(channel: string, factory: EchoRendererFactory): void {
  const existing = state.factories.get(channel);
  if (existing && existing !== factory) {
    log.warn(
      `echo renderer factory for "${channel}" is already registered; ignoring conflicting re-registration`,
    );
    return;
  }
  state.factories.set(channel, factory);
}

export function resolveEchoRendererFactory(channel: string): EchoRendererFactory | undefined {
  return state.factories.get(channel);
}

export function echoTargetKey(target: {
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

/**
 * Pure peek: true when a live streaming renderer is (or was) handling this target
 * for this session turn. Does NOT clear the mark. The post-hoc assistant mirror
 * should use {@link consumeStreamingEchoHandled} instead, so a mark can't outlive
 * the turn that set it.
 */
export function isStreamingEchoTargetHandled(
  sessionKey: string | undefined,
  target: { channel: string; to: string; accountId?: string; threadId?: string | number },
): boolean {
  if (!sessionKey) {
    return false;
  }
  return state.handledBySession.get(sessionKey)?.has(echoTargetKey(target)) ?? false;
}

/**
 * Consume-on-read: returns whether a live renderer handled this target this turn,
 * AND clears the mark. The post-hoc assistant mirror (message:sent hook and the
 * chat.send echo path) is the single consumer per turn — once it has skipped a
 * streamed target, the mark has done its job and must be released, otherwise a
 * LATER reply that delivers without launching a fan-out (a command reply, a
 * fast-abort reply) would read the stale mark and have its own post-hoc echo
 * wrongly suppressed. Returns false (no-op) for non-streamed targets and missing
 * sessions.
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
  const key = echoTargetKey(target);
  if (!set.delete(key)) {
    return false;
  }
  if (set.size === 0) {
    state.handledBySession.delete(sessionKey);
  }
  return true;
}

function markHandled(sessionKey: string | undefined, key: string): void {
  if (!sessionKey) {
    return;
  }
  let set = state.handledBySession.get(sessionKey);
  if (!set) {
    set = new Set<string>();
    state.handledBySession.set(sessionKey, set);
  }
  set.add(key);
}

function unmarkHandled(sessionKey: string | undefined, key: string): void {
  if (!sessionKey) {
    return;
  }
  const set = state.handledBySession.get(sessionKey);
  if (!set) {
    return;
  }
  set.delete(key);
  if (set.size === 0) {
    state.handledBySession.delete(sessionKey);
  }
}

export type StreamingEchoFanoutHandle = {
  /** Number of live renderers launched. */
  count: number;
  /** Abort all live renderers without finalizing (origin turn aborted). */
  dispose: () => Promise<void>;
};

/**
 * Launch one live renderer per streaming-enabled assistant echo target. Must be
 * called as the origin run starts (the agent-event bus has no replay buffer) — the
 * mirror resolver subscribes synchronously here.
 */
export async function launchStreamingEchoFanout(params: {
  originRunId: string;
  cfg: OpenClawConfig;
  sessionKey?: string;
  sessionEntry: SessionEntry | undefined;
  originChannel: string;
  originTo: string;
  originAccountId?: string;
  originThreadId?: string | number;
}): Promise<StreamingEchoFanoutHandle> {
  const targets = resolveEchoTargets(params.sessionEntry, {
    originChannel: params.originChannel,
    originTo: params.originTo,
    originAccountId: params.originAccountId,
    originThreadId: params.originThreadId,
    role: "assistant",
  });

  const active: Array<{ key: string; renderer: ChannelEchoRenderer; dispose: () => void }> = [];

  // Marks are per-run: a streamed target stays marked-handled for the WHOLE turn so
  // the post-hoc assistant mirror (message:sent, which fires after the run resolves)
  // skips it and we don't double-deliver. Clear the previous run's marks for this
  // session before re-marking what THIS run actually streams. (Turns are serialized
  // per session, so the prior run's post-hoc has already read its marks by now.)
  if (params.sessionKey) {
    state.handledBySession.delete(params.sessionKey);
  }

  for (const target of targets) {
    const factory = resolveEchoRendererFactory(target.channel);
    if (!factory) {
      continue;
    }
    let renderer: ChannelEchoRenderer | undefined;
    try {
      renderer = await factory({ cfg: params.cfg, target });
    } catch (err) {
      log.warn(
        `echo renderer factory failed for ${target.channel}:${target.to}: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    if (!renderer) {
      // Streaming disabled for this target (or unsupported) — post-hoc mirror handles it.
      continue;
    }
    const key = echoTargetKey(target);
    const label = `${target.channel}:${target.to}`;
    const { resolver, dispose: disposeResolver } = createMirrorReplyResolver({
      originRunId: params.originRunId,
      targetLabel: label,
    });
    markHandled(params.sessionKey, key);
    // Fire-and-forget: a target render must never block or abort the origin turn.
    // NOTE: do NOT unmark on resolve — the post-hoc message:sent mirror fires AFTER
    // the run resolves, and must still see this target as streaming-handled so it
    // skips it. The mark is released when that post-hoc mirror CONSUMES it
    // (consumeStreamingEchoHandled), so it can't outlive this turn; clear-at-launch
    // (above) and dispose are backstops for the run-errored-before-post-hoc edge.
    void resolver({} as MsgContext, renderer.options)
      .then((final) => renderer.finalize((final as ReplyPayload | undefined) ?? undefined))
      .catch((err: unknown) => {
        log.warn(`echo stream render failed for ${label}: ${formatErrorMessage(err)}`);
      });
    active.push({
      key,
      renderer,
      dispose: () => {
        disposeResolver();
        void Promise.resolve(renderer?.dispose()).catch(() => {});
        unmarkHandled(params.sessionKey, key);
      },
    });
  }

  return {
    count: active.length,
    dispose: async () => {
      for (const entry of active) {
        entry.dispose();
      }
    },
  };
}

export function resetEchoStreamingForTest(): void {
  state.factories.clear();
  state.handledBySession.clear();
}
