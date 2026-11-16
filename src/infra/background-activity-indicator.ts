/**
 * Background activity indicator: a periodic, session-scoped signal for
 * genuine background work that continues *after* a turn has ended -- a
 * subagent dispatch the parent is genuinely still waiting on, or an
 * automation/cron wake that is armed and will fire.
 *
 * This is deliberately independent of the turn-bound `TypingController`
 * (../auto-reply/reply/typing.ts). That controller seals itself once a
 * turn's run and dispatch both settle, specifically so late/stray events
 * after a finished turn cannot restart it forever -- correct behavior for
 * "this turn is over", but it leaves no signal at all for legitimate work
 * that outlives the turn. This module is that second signal. It reuses the
 * same reusable channel typing primitive (`createTypingCallbacks` over the
 * channel's `heartbeat.sendTypingGuarded`/`sendTyping` adapter) but always through a *fresh* instance
 * per activation, never the turn-bound controller's instance, so the two
 * can never observe or fight each other: each session key here owns its own
 * independent start/stop lifecycle, keyed apart from any turn-bound state.
 */
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createTypingCallbacks, type TypingCallbacks } from "../channels/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const DEFAULT_BACKGROUND_ACTIVITY_TYPING_INTERVAL_SECONDS = 6;

type BackgroundActivityChannelPlugin = Pick<ChannelPlugin, "heartbeat">;

type BackgroundActivityRoute = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  plugin: BackgroundActivityChannelPlugin;
};

function isSameRoute(a: BackgroundActivityRoute, b: BackgroundActivityRoute): boolean {
  return (
    a.plugin === b.plugin &&
    a.channel === b.channel &&
    a.to === b.to &&
    (a.accountId ?? null) === (b.accountId ?? null) &&
    (a.threadId ?? null) === (b.threadId ?? null)
  );
}

/** Poll cadence for re-evaluating which sessions still have armed background work.
 * Deliberately looser than the ~3-6s active-typing keepalive cadence
 * (createTypingKeepaliveLoop's default / DEFAULT_BACKGROUND_ACTIVITY_TYPING_INTERVAL_SECONDS):
 * this indicator answers "is anything still happening at all", not "render every
 * keystroke", so a per-session indicator can lag reality by up to one interval
 * without materially misleading the operator. */
export const DEFAULT_BACKGROUND_ACTIVITY_POLL_MS = 20_000;

export type BackgroundActivitySources = {
  /** Session (requester) keys with a live subagent run their parent is genuinely awaiting. */
  listArmedSubagentWaitSessionKeys: () => readonly string[] | Promise<readonly string[]>;
  /** Session keys bound to an enabled automation/cron job with a pending scheduled fire. */
  listArmedCronWakeSessionKeys: () => readonly string[] | Promise<readonly string[]>;
};

export type BackgroundActivityChannelTarget = {
  getConfig: () => OpenClawConfig;
  /** Resolve a session's current outbound delivery target, if it is routable at all. */
  resolveDelivery: (
    sessionKey: string,
  ) => DeliveryContext | undefined | Promise<DeliveryContext | undefined>;
  /** Resolve the loaded channel plugin providing `heartbeat.sendTyping(Guarded)`/`clearTyping`. */
  resolveChannelPlugin: (
    channel: string,
  ) =>
    | BackgroundActivityChannelPlugin
    | undefined
    | Promise<BackgroundActivityChannelPlugin | undefined>;
  /** Per-session/agent typing gate (e.g. `typingMode: "never"`); default true when omitted. */
  isTypingEnabled?: (sessionKey: string) => boolean;
  /** Per-session keepalive cadence override; channel default applies when omitted/undefined. */
  typingIntervalSeconds?: (sessionKey: string) => number | undefined;
  log?: (message: string) => void;
};

export type BackgroundActivityIndicatorOptions = {
  sources: BackgroundActivitySources;
  target: BackgroundActivityChannelTarget;
  isAvailable: () => boolean;
  /** Poll cadence for re-evaluating armed sessions. Default: DEFAULT_BACKGROUND_ACTIVITY_POLL_MS. */
  pollIntervalMs?: number;
  onError?: (error: unknown, context: { sessionKey?: string }) => void;
};

export type BackgroundActivityIndicator = {
  start: () => void;
  stop: () => void;
  /** Runs one evaluation pass immediately; exposed for tests and manual pokes. */
  tick: () => Promise<void>;
  isActiveForSession: (sessionKey: string) => boolean;
};

type ActiveSession = { controller: AbortController; callbacks?: TypingCallbacks };

async function resolveList(
  value: readonly string[] | Promise<readonly string[]>,
): Promise<readonly string[]> {
  return await value;
}

/** Creates the periodic engine. Call `start()` to begin polling. */
export function createBackgroundActivityIndicator(
  options: BackgroundActivityIndicatorOptions,
): BackgroundActivityIndicator {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BACKGROUND_ACTIVITY_POLL_MS;
  const active = new Map<string, ActiveSession>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight: Promise<void> | undefined;
  // Bumped by stop(). A pass that began under an older generation must not
  // register anything once its awaits settle: the instance it served is gone.
  let generation = 0;

  const stopSession = (sessionKey: string) => {
    const session = active.get(sessionKey);
    if (!session) {
      return;
    }
    active.delete(sessionKey);
    session.controller.abort();
    try {
      session.callbacks?.onCleanup?.();
    } catch (error) {
      options.onError?.(error, { sessionKey });
    }
  };

  const isTypingEnabled = (sessionKey: string) =>
    !options.target.isTypingEnabled || options.target.isTypingEnabled(sessionKey);

  /** The session's route as of now; undefined when it must not show typing. */
  const resolveRoute = async (sessionKey: string): Promise<BackgroundActivityRoute | undefined> => {
    if (!isTypingEnabled(sessionKey)) {
      return undefined;
    }
    const delivery = await options.target.resolveDelivery(sessionKey);
    const channel = delivery?.channel?.trim();
    const to = delivery?.to?.trim();
    if (!channel || !to) {
      return undefined;
    }
    const plugin = await options.target.resolveChannelPlugin(channel);
    if (!plugin?.heartbeat?.sendTypingGuarded && !plugin?.heartbeat?.sendTyping) {
      // No channel-level typing primitive to drive; this session cannot show
      // a background-activity signal at all. Not an error -- most channels
      // (and some accounts) simply do not implement typing.
      return undefined;
    }
    return { channel, to, accountId: delivery?.accountId, threadId: delivery?.threadId, plugin };
  };

  const startSession = async (sessionKey: string, isCurrentPass: () => boolean): Promise<void> => {
    if (active.has(sessionKey)) {
      return;
    }
    const route = await resolveRoute(sessionKey);
    // stop() or a concurrent pass may have run while the route resolved; never
    // register for a retired instance or a second, orphaned TypingCallbacks.
    if (!route || !isCurrentPass() || active.has(sessionKey)) {
      return;
    }
    const session: ActiveSession = { controller: new AbortController() };
    // Everything that can be checked without waiting: this exact activation is
    // still the registered one, the instance still serves, typing is still on.
    const isSessionCurrent = () =>
      active.get(sessionKey) === session &&
      !session.controller.signal.aborted &&
      options.isAvailable() &&
      isTypingEnabled(sessionKey);
    const retire = () => {
      if (active.get(sessionKey) === session) {
        stopSession(sessionKey);
      }
    };
    const target = (cfg: OpenClawConfig) => ({
      cfg,
      to: route.to,
      ...(route.accountId !== undefined ? { accountId: route.accountId } : {}),
      ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
    });
    const intervalSeconds = options.target.typingIntervalSeconds?.(sessionKey);
    session.callbacks = createTypingCallbacks({
      // Runs for the first send and every keepalive: nothing captured at
      // activation is trusted, so an opt-out or re-route takes effect on the
      // next send rather than whenever the session next disarms.
      start: async () => {
        if (!isSessionCurrent()) {
          retire();
          return;
        }
        const current = await resolveRoute(sessionKey);
        if (!isSessionCurrent() || !current || !isSameRoute(current, route)) {
          // The next poll re-activates against the new route, if there is one.
          retire();
          return;
        }
        const heartbeat = route.plugin.heartbeat;
        if (heartbeat?.sendTypingGuarded) {
          // Channels that own guarded typing re-check after their own transport waits.
          await heartbeat.sendTypingGuarded({
            ...target(options.target.getConfig()),
            signal: session.controller.signal,
            assertPlatformSendAuthorized: () => {
              if (!isSessionCurrent()) {
                retire();
                throw new Error("background activity typing is no longer current");
              }
            },
          });
          return;
        }
        await heartbeat?.sendTyping?.(target(options.target.getConfig()));
      },
      ...(route.plugin.heartbeat?.clearTyping
        ? {
            stop: async () =>
              route.plugin.heartbeat?.clearTyping?.(target(options.target.getConfig())),
          }
        : {}),
      keepaliveIntervalMs:
        (typeof intervalSeconds === "number" && intervalSeconds > 0
          ? intervalSeconds
          : DEFAULT_BACKGROUND_ACTIVITY_TYPING_INTERVAL_SECONDS) * 1000,
      onStartError: (err) => {
        if (session.controller.signal.aborted) {
          return;
        }
        options.target.log?.(
          `background activity typing failed for ${route.channel}: ${String(err)}`,
        );
      },
    });
    active.set(sessionKey, session);
    try {
      await session.callbacks.onReplyStart();
    } catch (error) {
      options.onError?.(error, { sessionKey });
    }
  };

  const runTick = async () => {
    const passGeneration = generation;
    const isCurrentPass = () => passGeneration === generation && options.isAvailable();
    if (!options.isAvailable()) {
      for (const sessionKey of active.keys()) {
        stopSession(sessionKey);
      }
      return;
    }
    const [subagentKeys, cronKeys] = await Promise.all([
      resolveList(options.sources.listArmedSubagentWaitSessionKeys()),
      resolveList(options.sources.listArmedCronWakeSessionKeys()),
    ]);
    if (!isCurrentPass()) {
      return;
    }
    const armed = new Set<string>();
    for (const sessionKey of subagentKeys) {
      if (sessionKey.trim()) {
        armed.add(sessionKey.trim());
      }
    }
    for (const sessionKey of cronKeys) {
      if (sessionKey.trim()) {
        armed.add(sessionKey.trim());
      }
    }
    for (const sessionKey of active.keys()) {
      if (!armed.has(sessionKey)) {
        stopSession(sessionKey);
      }
    }
    await Promise.all(
      [...armed].map((sessionKey) =>
        startSession(sessionKey, isCurrentPass).catch((error: unknown) => {
          // One session's resolution failure (e.g. a throwing plugin lookup)
          // must never block or fail the others in the same batch.
          options.onError?.(error, { sessionKey });
        }),
      ),
    );
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      return tickInFlight;
    }
    // Avoid overlapping evaluation passes if one tick's source queries stall
    // past the next poll -- mirrors createTypingKeepaliveLoop's tick guard.
    tickInFlight = runTick().finally(() => {
      tickInFlight = undefined;
    });
    return tickInFlight;
  };

  const start = () => {
    if (timer || pollIntervalMs <= 0) {
      return;
    }
    timer = setInterval(() => {
      void tick().catch((error: unknown) => options.onError?.(error, {}));
    }, pollIntervalMs);
    timer.unref?.();
  };

  const stop = () => {
    generation += 1;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const sessionKey of active.keys()) {
      stopSession(sessionKey);
    }
  };

  return {
    start,
    stop,
    tick,
    isActiveForSession: (sessionKey: string) => active.has(sessionKey),
  };
}
