import { randomUUID } from "node:crypto";
import type { TalkClientCreateResult } from "../../../../packages/gateway-protocol/src/schema/channels.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { BoundedSerialQueue } from "../../../shared/bounded-serial-queue.js";
import type { RealtimeVoiceAgentControlResult } from "../../../talk/agent-run-control.js";
import type { ClientVoiceSessionSource } from "../../../talk/client-voice-session-source.js";
import type { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import type {
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBrowserAudioContract,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../../../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { TalkEvent, TalkEventInput } from "../../../talk/talk-session-controller.js";
import { abortChatRunById } from "../../chat-abort.js";
import type { GatewayRequestContext } from "../../server-methods/shared-types.js";
import type { TalkAgentConsultAuthority } from "../client-gateway-control.js";
import type { TalkClientRunAuthority } from "../client-run-authority.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";
import type { RelayToolCallLedger } from "./tool-call-ledger.js";

export const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const RELAY_EVENT = "talk.event";
export const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;

export const noFallbackRelayOutputFlush = () => {};

type TalkRealtimeRelayEventData =
  | { type: "ready" }
  | { type: "responseStarted"; turnId: string }
  | { type: "inputAudio"; byteLength: number }
  | {
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { type: "audioDone"; itemId?: string; responseId?: string }
  | { type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { type: "mark"; markName: string }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
      textMode?: "snapshot";
      transcriptId?: string;
    }
  | {
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { type: "toolCallCancelled"; callId: string }
  | { type: "toolResult"; callId: string }
  | { type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { type: "close"; reason: "completed" | "error" };

export type TalkRealtimeRelayEventPayload = TalkRealtimeRelayEventData & { relaySessionId: string };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventData & { talkEvent?: TalkEvent };

export type ForcedTerminalProviderResult = {
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  turnId: string;
  epoch: number;
  nativeCallIds?: readonly string[];
};

export type RelayAgentControlProviderSubmission = {
  completion?: Promise<void>;
  providerResponseStarted: boolean;
};

export class TalkRealtimeRelayOutputOwnership {
  mode: "turn-bound" | "exact-response" = "turn-bound";
  phase: "unowned" | "owned" | "cancelling" | "discarding" = "unowned";
  outputGeneration = 0;
  turnId?: string;
  responseId?: string;
  drain?: { promise: Promise<void>; resolve: () => void };
  private cancelledTerminal?: { responseId?: string };

  constructor(
    private readonly activeTurnId: () => string | undefined,
    private readonly ensureTurn: () => string,
    private readonly fail: (message: string) => void,
  ) {}

  get discarding(): boolean {
    return this.phase === "discarding";
  }

  isDiscarding(generation: number): boolean {
    return this.discarding && this.outputGeneration === generation;
  }

  get suppressingOutput(): boolean {
    return this.phase === "cancelling" || this.discarding;
  }

  responseCreated(responseId: string | undefined): boolean {
    const normalizedResponseId = responseId?.trim();
    if (this.discarding) {
      if (!normalizedResponseId || normalizedResponseId === this.responseId) {
        return false;
      }
      this.finish(this.responseId);
    }
    if (this.phase === "unowned") {
      this.cancelledTerminal = undefined;
      Object.assign(this, {
        mode: normalizedResponseId ? ("exact-response" as const) : ("turn-bound" as const),
        phase: "owned" as const,
        turnId: this.ensureTurn(),
        responseId: normalizedResponseId,
      });
      return true;
    }
    if (
      this.phase === "owned" &&
      this.mode === "exact-response" &&
      normalizedResponseId &&
      normalizedResponseId === this.responseId
    ) {
      return true;
    }
    this.fail("Realtime provider output has no live response owner.");
    return false;
  }

  resolve(claim: boolean): string | undefined {
    if (this.discarding) {
      return undefined;
    }
    const activeTurnId = this.activeTurnId();
    if (activeTurnId && this.mode === "turn-bound" && claim && this.phase === "unowned") {
      this.cancelledTerminal = undefined;
      Object.assign(this, { phase: "owned" as const, turnId: activeTurnId });
    }
    const turnId =
      this.phase === "owned" && this.turnId === activeTurnId ? activeTurnId : undefined;
    if (!turnId && (claim || this.phase === "owned")) {
      this.fail("Realtime provider output has no live response owner.");
    }
    return turnId;
  }

  finish(responseId: string | undefined, cancellationEvent = false) {
    const cancelled = this.suppressingOutput;
    if (
      (cancellationEvent && !cancelled) ||
      (this.mode === "exact-response" &&
        (this.phase === "unowned" || this.responseId !== responseId))
    ) {
      return "ignore";
    }
    this.drain?.resolve();
    Object.assign(this, { phase: "unowned" as const, turnId: undefined, responseId: undefined });
    return cancelled ? "cancelled" : "completed";
  }

  /** Resume input without releasing the unconfirmed provider response's output ownership. */
  completeCancellationLocally(): number | undefined {
    if (this.phase !== "cancelling") {
      return undefined;
    }
    this.phase = "discarding";
    this.drain?.resolve();
    return ++this.outputGeneration;
  }

  resetContinuity(): void {
    this.outputGeneration += 1;
    this.cancelledTerminal = undefined;
    this.drain?.resolve();
    Object.assign(this, { phase: "unowned" as const, turnId: undefined, responseId: undefined });
  }

  bind(
    provider: RealtimeVoiceProviderPlugin,
    runAgentConsult: RealtimeVoiceAgentConsultRunner,
  ): RealtimeVoiceProviderPlugin {
    return {
      ...provider,
      createBridge: (request) =>
        provider.createBridge({
          ...request,
          onEvent: (event) => {
            if (event.direction === "server") {
              if (event.type === "response.done" || event.type === "response.cancelled") {
                if (
                  this.cancelledTerminal &&
                  this.cancelledTerminal.responseId === event.responseId
                ) {
                  this.cancelledTerminal = undefined;
                  return;
                }
                if (this.suppressingOutput) {
                  this.finish(event.responseId, true);
                  return;
                }
              }
              if (event.type === "response.created" && !this.responseCreated(event.responseId)) {
                return;
              }
            }
            request.onEvent?.(event);
          },
          onResponseDone: (outcome) => {
            // The Talk turn is already cancelled. Settle its provider owner before the
            // harness rejects that terminal or mistakes it for a successor input turn.
            if (this.suppressingOutput) {
              if (this.finish(outcome.responseId) !== "ignore") {
                // Typed providers may emit a diagnostic legacy twin in the same dispatch.
                this.cancelledTerminal = { responseId: outcome.responseId };
              }
              return;
            }
            request.onResponseDone?.(outcome);
          },
          runAgentConsult,
        }),
    };
  }
}

export type RelayAgentRun = {
  runId: string;
  sessionKey: string;
  standalone?: RelayAgentRunRegistration;
  releaseVoice?: () => void;
};

export type RelayAgentRunRegistration = {
  run: RelayAgentRun;
  isCurrent: () => boolean;
  release: () => void;
  abortIfCurrent: () => void;
};

export type RelaySession = {
  getToolAuthorityOverlay?: (
    authority?: TalkAgentConsultAuthority,
    source?: "reply" | "attempt",
  ) => import("../../../auto-reply/reply/reply-run-registry.contracts.js").ReplyToolAuthorityOverlay;
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  harness: RealtimeVoiceSessionHarness;
  capabilities?: InternalRealtimeVoiceProviderCapabilities;
  outputOwnership: TalkRealtimeRelayOutputOwnership;
  sessionTarget: PreparedTalkSessionTarget;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, RelayAgentRun>;
  provider: string;
  activeAgentToolCalls: Map<string, RelayAgentRunRegistration>;
  toolCalls: RelayToolCallLedger;
  providerToolCallIds: Map<string, string>;
  relayToolCallIdsByProviderId: Map<string, string>;
  pendingFinalToolResults: Map<string, Promise<void>>;
  pendingProviderToolResults: Map<string, Promise<void>>;
  // A final result must wait until the provider accepts its continuation result;
  // otherwise async bridges can observe final-before-working ordering.
  pendingWorkingToolResults: Map<string, Promise<void>>;
  // Keep a forced terminal result open while late matching native ids join it.
  // Delivery/cancellation closes the state only after every current id accepts.
  forcedTerminalProviderResults: Map<string, ForcedTerminalProviderResult>;
  // Turn cancellation invalidates async acceptance callbacks from the prior turn.
  toolResultEpoch: number;
  voiceConfig?: OpenClawConfig;
  voiceSessionSource?: ClientVoiceSessionSource;
  voiceSessionCreated: boolean;
  voiceSessionCreation?: Promise<boolean>;
  voiceTranscriptSeq: number;
  voiceTranscriptQueue: BoundedSerialQueue;
  runAuthority?: TalkClientRunAuthority;
  transcriptReadiness: ReturnType<typeof createClientVoiceTranscriptReadiness>;
  voiceSessionClose?: Promise<void>;
  closing?: {
    reason: "completed" | "error";
    completion?: Promise<void>;
    runTranscript?: (run: () => boolean) => boolean;
  };
  failSession: (message: string) => void;
};

export type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  consultAuthority?: TalkAgentConsultAuthority;
  runAuthority?: TalkClientRunAuthority;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  controlSource: "delegation" | "transcript";
  capabilities?: InternalRealtimeVoiceProviderCapabilities;
  clientCapabilities?: readonly "voice-selection"[];
  voiceChangeId?: string;
  voiceSelectionVoices?: readonly string[];
  initialItems?: Array<{ role: "user" | "assistant"; text: string }>;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionTarget: PreparedTalkSessionTarget;
  voice?: string;
  language?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
};

export type TalkRealtimeRelaySessionResult = Omit<
  Extract<TalkClientCreateResult, { transport: "gateway-relay" }>,
  "voiceSessionId" | "audio"
> & {
  audio: RealtimeVoiceBrowserAudioContract;
  expiresAt: number;
};

export const relaySessions = new Map<string, RelaySession>();
// Closing relays reject new work but retain bounded final transcripts until
// provider finalization and durable close settle. Session limits count both sets.
export const drainingRelaySessions = new Set<RelaySession>();

export function adoptRelayProviderToolCallId(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  if (session.toolCalls.isProviderCompleted(providerCallId)) {
    return undefined;
  }
  const current = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (current) {
    return session.toolCalls.isAgentCompleted(current) ? undefined : current;
  }
  const relayCallId = session.toolCalls.isAgentCompleted(providerCallId)
    ? `relay-${randomUUID()}`
    : providerCallId;
  // Realtime protocols define no replay window. Retain every admitted identity
  // for the session and fail closed at the hard cap instead of evicting dedupe state.
  if (!session.toolCalls.tryAdmit([providerCallId, relayCallId])) {
    return undefined;
  }
  session.toolCalls.deleteAgentCompleted(relayCallId);
  session.providerToolCallIds.set(relayCallId, providerCallId);
  session.relayToolCallIdsByProviderId.set(providerCallId, relayCallId);
  return relayCallId;
}

export function resolveRelayProviderToolCallId(session: RelaySession, relayCallId: string): string {
  return session.providerToolCallIds.get(relayCallId) ?? relayCallId;
}

export function broadcastToOwner(
  session: Pick<RelaySession, "id" | "context" | "connId" | "harness">,
  event: TalkRealtimeRelayEvent,
  talkEvent?: TalkEventInput,
): void {
  const payload = {
    relaySessionId: session.id,
    ...event,
    ...(talkEvent ? { talkEvent: session.harness.talk.emit(talkEvent) } : {}),
  };
  // Classify the materialized Talk event so final results cannot be mistaken
  // for transient tool progress by individual provider callback paths.
  const dropIfSlow =
    event.type === "audio" ||
    event.type === "inputAudio" ||
    (event.type === "transcript" && !event.final) ||
    ((event.type === "toolProgress" || event.type === "toolResult") &&
      payload.talkEvent?.final !== true);
  session.context.broadcastToConnIds(RELAY_EVENT, payload, new Set([session.connId]), {
    dropIfSlow,
  });
}

export function broadcastRelaySessionClosed(
  session: RelaySession,
  reason: "completed" | "error",
  eventReason?: "output-cancelled",
): void {
  broadcastToOwner(
    session,
    { type: "close", reason },
    {
      type: "session.closed",
      payload: { reason: reason === "error" ? "error" : (eventReason ?? reason) },
      final: true,
    },
  );
}

export function cancelRelayTurn(session: RelaySession, turnId: string, reason: string): void {
  const cancelled = session.harness.talk.cancelTurn({ turnId, payload: { reason } });
  broadcastToOwner(session, {
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

export function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session, { type: "inputAudio", byteLength: 0, talkEvent: turn.event });
  }
  return turn.turnId;
}

/** The two existing indexes own one run with independent provider-call registrations. */
export function hasRelayAgentRunRegistrations(
  session: RelaySession,
  run: RelayAgentRun,
  except?: RelayAgentRunRegistration,
): boolean {
  return (
    Boolean(run.standalone && run.standalone !== except) ||
    [...session.activeAgentToolCalls.values()].some(
      (registration) => registration.run === run && registration !== except,
    )
  );
}

export function pruneInactiveRelayAgentRuns(session: RelaySession): number {
  for (const runId of session.activeAgentRuns.keys()) {
    if (!session.context.chatAbortControllers.has(runId)) {
      session.activeAgentRuns.delete(runId);
    }
  }
  for (const [callId, { run }] of session.activeAgentToolCalls) {
    if (session.activeAgentRuns.get(run.runId) !== run) {
      session.activeAgentToolCalls.delete(callId);
    }
  }
  return session.activeAgentRuns.size;
}

/** Omitting the abort reason releases relay correlation while accepted work continues. */
export function retireRelayAgentRuns(session: RelaySession, reason?: string): void {
  if (reason !== undefined) {
    for (const [runId, run] of session.activeAgentRuns) {
      const current =
        run.standalone?.isCurrent() ||
        [...session.activeAgentToolCalls.values()].some(
          (registration) => registration.run === run && registration.isCurrent(),
        );
      if (current) {
        abortChatRunById(session.context, {
          runId,
          sessionKey: run.sessionKey,
          stopReason: reason,
        });
      }
    }
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

/** Drops one provider generation without sending cancellation into its replacement. */
export function resetTalkRealtimeRelayContinuity(
  session: RelaySession,
  reason = "session.continuity.reset",
): TalkEvent | undefined {
  session.toolResultEpoch += 1;
  const retiredCallIds = new Set<string>([
    ...session.activeAgentToolCalls.keys(),
    ...session.toolCalls.cancelledCallIds(),
    ...session.providerToolCallIds.keys(),
    ...session.providerToolCallIds.values(),
    ...session.pendingFinalToolResults.keys(),
    ...session.pendingProviderToolResults.keys(),
    ...session.pendingWorkingToolResults.keys(),
    ...session.forcedTerminalProviderResults.keys(),
  ]);
  for (const handle of session.harness.forcedConsults.handles()) {
    retiredCallIds.add(handle.id);
    for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(handle)) {
      retiredCallIds.add(nativeCallId);
    }
  }
  if (!session.toolCalls.markAgentCompleted(retiredCallIds)) {
    return undefined;
  }
  session.toolCalls.clearCancelled();
  session.providerToolCallIds.clear();
  session.relayToolCallIdsByProviderId.clear();
  session.pendingFinalToolResults.clear();
  session.toolCalls.clearProviderCompleted();
  session.pendingProviderToolResults.clear();
  session.pendingWorkingToolResults.clear();
  session.forcedTerminalProviderResults.clear();
  session.harness.forcedConsults.clear();
  retireRelayAgentRuns(session, reason);
  const turnId = session.harness.talk.activeTurnId;
  session.harness.flushOutput(noFallbackRelayOutputFlush);
  session.harness.finishOutputAudio(reason);
  if (!turnId) {
    return undefined;
  }
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  return cancelled.ok ? cancelled.event : undefined;
}
