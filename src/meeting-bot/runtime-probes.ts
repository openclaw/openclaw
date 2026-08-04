import { sleep } from "../utils/sleep.js";
import type { MeetingBrowserHealthRefreshOutcome } from "./session-runtime-probes.js";
import type { MeetingPluginJoinRequest, MeetingPluginProbeHealth } from "./session-types.js";

export function resolveMeetingProbeTimeoutMs(
  input: number | undefined,
  fallback: number,
  invalidRequest: (message: string) => Error = (message) => new Error(message),
): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw invalidRequest("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}

type MeetingProbeSession<Health extends MeetingPluginProbeHealth> = {
  id: string;
  chrome?: {
    launched: boolean;
    browserTab?: { targetId?: string };
    health?: Health;
  };
};

type MeetingProbeRequest<Transport extends string> = MeetingPluginJoinRequest<Transport, string>;

type MeetingProbeConfig<Mode extends string> = {
  defaultMode: Mode;
  chrome: { joinTimeoutMs: number };
  chromeNode: { node?: string };
};

type MeetingProbeRefreshOutcome = MeetingBrowserHealthRefreshOutcome;

type MeetingProbeRefreshResult = MeetingProbeRefreshOutcome | boolean | void;

export type MeetingProbeContext<
  Config extends MeetingProbeConfig<Mode>,
  Mode extends string,
  Transport extends string,
  Health extends MeetingPluginProbeHealth,
  Session extends MeetingProbeSession<Health>,
  Request extends MeetingProbeRequest<Transport>,
> = {
  config: Config;
  resolveAgentId(request: Request): string;
  list(): Session[];
  join(request: Request): Promise<{
    browserHealthChecked?: boolean;
    manualActionIsAuthoritative?: boolean;
    session: Session;
    spoken?: boolean;
  }>;
  isReusable(
    session: Session,
    resolved: { url: string; transport: Transport; mode: Mode; agentId: string },
  ): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: Session, timeoutMs?: number): Promise<MeetingProbeRefreshResult>;
};

type MeetingRuntimeProbeOptions<
  Mode extends string,
  Health extends MeetingPluginProbeHealth,
  Session extends MeetingProbeSession<Health>,
> = {
  defaultSpeechMessage: string;
  invalidRequest(message: string): Error;
  resolveTimeoutMs(input: number | undefined, fallback: number): number;
  shouldWaitForListening(session: Session): boolean;
  talkBackMode(mode: Mode): boolean;
};

export function createMeetingRuntimeProbes<
  Config extends MeetingProbeConfig<Mode>,
  Mode extends string,
  Transport extends string,
  Health extends MeetingPluginProbeHealth,
  Session extends MeetingProbeSession<Health>,
  Request extends MeetingProbeRequest<Transport>,
>(
  options: MeetingRuntimeProbeOptions<Mode, Health, Session> & {
    normalizeUrl?(url: string): string;
    resolveRequestMode?(mode: Request["mode"], config: Config): Mode | undefined;
    defaultTransport?(config: Config): Transport;
    validateListeningTransport?(transport: Transport): void;
    resolveSpeechTimeoutMs?(request: Request, config: Config): number;
    refreshCaptionHealth?(
      context: MeetingProbeContext<Config, Mode, Transport, Health, Session, Request>,
      session: Session,
      timeoutMs: number,
    ): Promise<MeetingProbeRefreshResult>;
    speechModeError?: string;
    listeningModeError?: string;
  },
) {
  type Context = MeetingProbeContext<Config, Mode, Transport, Health, Session, Request>;

  const testSpeech = async (context: Context, request: Request) => {
    const requestMode =
      options.resolveRequestMode?.(request.mode, context.config) ??
      (request.mode as Mode | undefined);
    if (requestMode === "transcribe") {
      throw options.invalidRequest(
        options.speechModeError ?? "test_speech requires mode: agent or bidi",
      );
    }
    const requestedMode = requestMode ?? context.config.defaultMode;
    const mode = options.talkBackMode(requestedMode) ? requestedMode : ("agent" as Mode);
    const resolved = {
      url: options.normalizeUrl?.(request.url) ?? request.url,
      transport:
        request.transport ??
        options.defaultTransport?.(context.config) ??
        (context.config.chromeNode.node ? ("chrome-node" as Transport) : ("chrome" as Transport)),
      mode,
      agentId: context.resolveAgentId(request),
    };
    const beforeSessions = context.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
    const existingBaseline = {
      outputBytes: existing?.chrome?.health?.lastOutputBytes ?? 0,
      outputGeneration: existing?.chrome?.health?.outputGeneration ?? 0,
    };
    const result = await context.join({
      ...request,
      ...resolved,
      message: request.message ?? options.defaultSpeechMessage,
    });
    const baseline =
      existing?.id === result.session.id
        ? existingBaseline
        : { outputBytes: 0, outputGeneration: 0 };
    let health = result.session.chrome?.health;
    const verified = () =>
      (health?.lastOutputBytes ?? 0) > baseline.outputBytes &&
      (health?.outputGeneration ?? 0) > baseline.outputGeneration &&
      health?.verifiedOutputGeneration === health?.outputGeneration;
    const shouldWait =
      result.spoken === true &&
      health?.manualAction === undefined &&
      context.hasHealthHandle(result.session.id);
    if (shouldWait && !verified()) {
      const deadline =
        Date.now() +
        (options.resolveSpeechTimeoutMs?.(request, context.config) ??
          options.resolveTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs));
      while (Date.now() < deadline && !verified()) {
        await sleep(100);
        context.refreshHealth(result.session.id);
        health = result.session.chrome?.health;
      }
    }
    const speechOutputVerified = verified();
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualAction: health?.manualAction,
      spoken: result.spoken ?? false,
      speechOutputVerified,
      speechOutputTimedOut: shouldWait && !speechOutputVerified,
      speechReady: health?.speechReady,
      speechBlockedReason: health?.speechBlockedReason,
      speechBlockedMessage: health?.speechBlockedMessage,
      audioOutputActive: health?.audioOutputActive,
      lastOutputBytes: health?.lastOutputBytes,
      outputLoopbackSignalBytes: health?.outputLoopbackSignalBytes,
      lastOutputLoopbackAt: health?.lastOutputLoopbackAt,
      lastOutputLoopbackCorrelation: health?.lastOutputLoopbackCorrelation,
      lastOutputLoopbackRms: health?.lastOutputLoopbackRms,
      lastOutputLoopbackPeak: health?.lastOutputLoopbackPeak,
      outputGeneration: health?.outputGeneration,
      verifiedOutputGeneration: health?.verifiedOutputGeneration,
      session: result.session,
    };
  };

  const testListening = async (context: Context, request: Request) => {
    const requestMode =
      options.resolveRequestMode?.(request.mode, context.config) ??
      (request.mode as Mode | undefined);
    if (requestMode && requestMode !== "transcribe") {
      throw options.invalidRequest(
        options.listeningModeError ?? "test_listen requires mode: transcribe",
      );
    }
    const resolved = {
      url: options.normalizeUrl?.(request.url) ?? request.url,
      transport:
        request.transport ??
        options.defaultTransport?.(context.config) ??
        (context.config.chromeNode.node ? ("chrome-node" as Transport) : ("chrome" as Transport)),
      mode: "transcribe" as Mode,
      agentId: context.resolveAgentId(request),
    };
    options.validateListeningTransport?.(resolved.transport);
    const beforeSessions = context.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
    const start = {
      lines: existing?.chrome?.health?.transcriptLines ?? 0,
      at: existing?.chrome?.health?.lastCaptionAt,
      text: existing?.chrome?.health?.lastCaptionText,
    };
    const result = await context.join({ ...request, ...resolved, message: undefined });
    let health = result.session.chrome?.health;
    const advanced = () =>
      (health?.transcriptLines ?? 0) > (existing?.id === result.session.id ? start.lines : 0) ||
      Boolean(health?.lastCaptionAt && health.lastCaptionAt !== start.at) ||
      Boolean(health?.lastCaptionText && health.lastCaptionText !== start.text);
    const reusedSession = existing?.id === result.session.id;
    const hasAuthoritativeManualAction =
      result.manualActionIsAuthoritative === true && health?.manualAction !== undefined;
    const manualActionRequiresRecovery =
      result.manualActionIsAuthoritative === false ||
      (result.manualActionIsAuthoritative === undefined &&
        reusedSession &&
        result.browserHealthChecked === false);
    const shouldWait =
      options.shouldWaitForListening(result.session) &&
      !hasAuthoritativeManualAction &&
      (health?.manualAction === undefined || manualActionRequiresRecovery);
    let manualActionIsAuthoritative =
      result.manualActionIsAuthoritative ??
      // Omitted metadata preserves the legacy join contract. Explicit false is never promoted.
      (!shouldWait || result.browserHealthChecked !== false);
    let listenVerified = advanced();
    if (shouldWait && !listenVerified) {
      const deadline =
        Date.now() +
        options.resolveTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadlineReached = new Promise<{
          browserHealthChecked: false;
          completed: false;
        }>((resolve) => {
          deadlineTimer = setTimeout(
            () => resolve({ browserHealthChecked: false, completed: false }),
            remainingMs,
          );
        });
        const refreshOutcome = await Promise.race([
          (
            options.refreshCaptionHealth?.(context, result.session, remainingMs) ??
            context.refreshCaptionHealth(result.session, remainingMs)
          ).then((result) => {
            const outcome =
              typeof result === "object"
                ? result
                : {
                    // Legacy contexts returned void after a successful refresh. Preserve that
                    // contract, while allowing canonical owners to report a closed outcome.
                    browserHealthChecked: result !== false,
                    manualActionIsAuthoritative: result !== false,
                  };
            return { ...outcome, completed: true as const };
          }),
          deadlineReached,
        ]).finally(() => {
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
          }
        });
        if (!refreshOutcome.completed) {
          break;
        }
        health = result.session.chrome?.health;
        if (Date.now() >= deadline) {
          break;
        }
        if (advanced()) {
          listenVerified = true;
        }
        manualActionIsAuthoritative =
          refreshOutcome.manualActionIsAuthoritative ??
          // Compatibility inference applies only when older refresh implementations omit it.
          (refreshOutcome.browserHealthChecked ? true : manualActionIsAuthoritative);
        if (listenVerified || (manualActionIsAuthoritative && health?.manualAction)) {
          break;
        }
        const retryDelayMs = deadline - Date.now();
        if (retryDelayMs <= 0) {
          break;
        }
        await sleep(Math.min(250, retryDelayMs));
      }
    }
    const manualAction = manualActionIsAuthoritative ? health?.manualAction : undefined;
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualAction,
      listenVerified,
      listenTimedOut: shouldWait && !listenVerified && manualAction === undefined,
      captioning: health?.captioning,
      captionsEnabledAttempted: health?.captionsEnabledAttempted,
      transcriptLines: health?.transcriptLines,
      lastCaptionAt: health?.lastCaptionAt,
      lastCaptionSpeaker: health?.lastCaptionSpeaker,
      lastCaptionText: health?.lastCaptionText,
      recentTranscript: health?.recentTranscript,
      session: result.session,
    };
  };

  return { testListening, testSpeech };
}
