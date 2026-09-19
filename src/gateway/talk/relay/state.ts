import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { BoundedSerialQueue } from "../../../shared/bounded-serial-queue.js";
import type { RealtimeVoiceAgentControlResult } from "../../../talk/agent-run-control.js";
import type { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import type {
  RealtimeVoiceBrowserAudioContract,
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../../../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { TalkEvent } from "../../../talk/talk-session-controller.js";
import type { GatewayRequestContext } from "../../server-methods/shared-types.js";
import type { TalkAgentConsultAuthority } from "../client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";
import type { RelayToolCallLedger } from "./tool-call-ledger.js";

export const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
export const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;

export const noFallbackRelayOutputFlush = () => {};

export type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "responseStarted"; turnId: string }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolCallCancelled"; callId: string }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      relaySessionId: string;
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

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

type RelayProvider = RealtimeVoiceProviderPlugin;
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
    if (
      this.phase !== "cancelling" &&
      activeTurnId &&
      this.mode === "turn-bound" &&
      claim &&
      this.phase === "unowned"
    ) {
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

  bind(provider: RelayProvider, runAgentConsult: RealtimeVoiceAgentConsultRunner): RelayProvider {
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
  activeAgentRuns: Map<string, string>;
  provider: string;
  activeAgentToolCalls: Map<string, string>;
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
  voiceSessionCreated: boolean;
  voiceTranscriptSeq: number;
  voiceTranscriptQueue: BoundedSerialQueue;
  confirmationReadiness: ReturnType<typeof createClientVoiceConfirmationReadiness>;
  voiceSessionClose?: Promise<void>;
  closing?: { reason: "completed" | "error"; completion?: Promise<void> };
  failSession: (message: string) => void;
};

export type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  consultAuthority?: TalkAgentConsultAuthority;
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

export type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

export const relaySessions = new Map<string, RelaySession>();
// Closing relays reject new work but retain bounded final transcripts until
// provider finalization and durable close settle. Session limits count both sets.
export const drainingRelaySessions = new Set<RelaySession>();

export function assertRelaySessionCapacity(connId: string): void {
  const sessions = [...relaySessions.values(), ...drainingRelaySessions];
  if (sessions.length >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  const connectionCount = sessions.filter((session) => session.connId === connId).length;
  if (connectionCount >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

export function adoptRelayProviderToolCallId(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  if (session.toolCalls.isProviderCompleted(providerCallId)) {
    return undefined;
  }
  const current = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (current) {
    if (session.toolCalls.isAgentCompleted(current)) {
      return undefined;
    }
    return current;
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
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  // Classify the materialized Talk event so final results cannot be mistaken
  // for transient tool progress by individual provider callback paths.
  const delivery = relayEventDeliveryOptions(event, event.talkEvent);
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), delivery);
}

function relayEventDeliveryOptions(
  event: TalkRealtimeRelayEventPayload,
  talkEvent?: TalkEvent,
): {
  dropIfSlow?: boolean;
} {
  switch (event.type) {
    case "audio":
    case "inputAudio":
      return { dropIfSlow: true };
    case "transcript":
      return { dropIfSlow: !event.final };
    case "toolProgress":
    case "toolResult":
      return { dropIfSlow: talkEvent?.final !== true };
    default:
      return { dropIfSlow: false };
  }
}

export function broadcastRelaySessionClosed(
  session: RelaySession,
  reason: "completed" | "error",
  eventReason?: "output-cancelled",
): void {
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.harness.talk.emit({
      type: "session.closed",
      payload: { reason: reason === "error" ? "error" : (eventReason ?? reason) },
      final: true,
    }),
  });
}

export function cancelRelayTurn(session: RelaySession, turnId: string, reason: string): void {
  const cancelled = session.harness.talk.cancelTurn({ turnId, payload: { reason } });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

export function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}
