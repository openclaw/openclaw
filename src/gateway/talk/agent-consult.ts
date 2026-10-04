import { randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../auto-reply/command-sender-authority.js";
import { normalizeTalkSection } from "../../config/talk.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../../talk/agent-consult-tool.js";
import { abortChatRunById } from "../chat-abort.js";
import { handleTrustedInternalChatSend } from "../server-methods/chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/shared-types.js";
import { formatForLog } from "../ws-log.js";
import { prepareTalkAgentConsultTranscript } from "./agent-consult-transcript.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";
import { registerTalkRealtimeRelayAgentRun } from "./relay/index.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

function terminalTalkChatSendAckError(result: unknown): ErrorShape | undefined {
  const status = asNullableRecord(result)?.status;
  const message =
    status === "timeout"
      ? "Realtime agent consult ended before the run started."
      : status === "error"
        ? "Realtime agent consult failed before the run started."
        : status === "ok"
          ? "Realtime agent consult completed before the tool result subscription started."
          : undefined;
  return message ? errorShape(ErrorCodes.UNAVAILABLE, message) : undefined;
}

type TalkConsultStart =
  | { ok: true; runId: string; idempotencyKey: string }
  | { ok: false; error: ErrorShape };

type InFlightTalkConsult = {
  startedAt: number;
  request: string;
  start: Promise<TalkConsultStart>;
};

const CONSULT_JOIN_WINDOW_MS = 120_000;
const inFlightConsults = new Map<string, InFlightTalkConsult>();

/** Comparison form of a consult request: a repeat matches whatever its spacing or letter case. */
export function normalizeTalkConsultJoinRequest(args: {
  question: string;
  context?: string;
  responseStyle?: string;
}): string {
  return [args.question, args.context ?? "", args.responseStyle ?? ""]
    .map((part) => part.trim().replace(/\s+/g, " ").toLowerCase())
    .join("\n");
}

/**
 * Start a consult, or join the one already in flight for the same request in this voice session.
 *
 * A realtime model that repeats the consult tool call would otherwise send one
 * chat message per repeat into the busy session. Each returns at once with no
 * text, the model calls again, and the session is left with a backlog of turns.
 * A different request is never joined: it gets its own start, and chat admission
 * answers it while the earlier run is still active.
 */
export async function joinOrStartTalkConsult(params: {
  key: string;
  request: string;
  isRunLive: (runId: string) => boolean;
  start: () => Promise<TalkConsultStart>;
}): Promise<TalkConsultStart> {
  let liveOther: InFlightTalkConsult | undefined;
  for (;;) {
    const prior = inFlightConsults.get(params.key);
    // 120 s matches the client's consult wait and bounds a run whose completion
    // was never observed.
    if (!prior || Date.now() - prior.startedAt >= CONSULT_JOIN_WINDOW_MS) {
      break;
    }
    const result = await prior.start;
    if (result.ok && params.isRunLive(result.runId)) {
      if (prior.request === params.request) {
        return result;
      }
      liveOther = prior;
      break;
    }
    if (inFlightConsults.get(params.key) === prior) {
      inFlightConsults.delete(params.key);
      break;
    }
  }
  const entry = { startedAt: Date.now(), request: params.request, start: params.start() };
  // Entries past the join window are never joined; drop them so the map stays bounded.
  for (const [key, stale] of inFlightConsults) {
    if (entry.startedAt - stale.startedAt >= CONSULT_JOIN_WINDOW_MS) {
      inFlightConsults.delete(key);
    }
  }
  if (liveOther) {
    // The live run keeps its entry so its own repeats still join. This request
    // replaces it only if it really started.
    const result = await entry.start;
    const current = inFlightConsults.get(params.key);
    if (result.ok && (!current || current.startedAt <= entry.startedAt)) {
      inFlightConsults.set(params.key, entry);
    }
    return result;
  }
  inFlightConsults.set(params.key, entry);
  const result = await entry.start;
  if (!result.ok && inFlightConsults.get(params.key) === entry) {
    inFlightConsults.delete(params.key);
  }
  return result;
}

/** Starts the chat run that backs a realtime Talk tool call. */
export async function startTalkRealtimeAgentConsult(
  request: GatewayRequestHandlerOptions,
  params: {
    sessionTarget: PreparedTalkSessionTarget;
    callId: string;
    args: unknown;
    relaySessionId?: string;
    connId?: string;
    onRunStarted?: (runId: string) => void;
  },
): Promise<{ ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const normalizedTalk = normalizeTalkSection(request.context.getRuntimeConfig().talk);
  const authority = resolveTalkAgentConsultAuthority(
    request.client?.connect?.scopes,
    request.client,
  );
  let acknowledgedRunId: string | undefined;
  const chatResponse = await new Promise<
    { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined
  >((resolve) => {
    let acknowledged = false;
    const chatSendOptions = {
      ...request,
      client:
        request.client && authority.replyCaller
          ? withCommandSenderAuthority(
              {
                ...request.client,
                connect: {
                  ...request.client.connect,
                  caps: authority.replyCaller.GatewayClientCaps,
                },
              },
              getCommandSenderAuthority(authority.replyCaller),
            )
          : request.client,
      req: {
        type: "req",
        id: `${request.req.id}:talk-tool-call`,
        method: "chat.send",
      },
      params: {
        sessionKey: params.sessionTarget.canonicalKey,
        agentId: params.sessionTarget.agentId,
        message,
        idempotencyKey,
        suppressCommandInterpretation: true,
        systemInputProvenance: {
          kind: "internal_system",
          sourceTool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        },
        ...(normalizedTalk?.consultThinkingLevel
          ? { thinking: normalizedTalk.consultThinkingLevel }
          : {}),
        ...(typeof normalizedTalk?.consultFastMode === "boolean"
          ? { fastMode: normalizedTalk.consultFastMode }
          : {}),
      },
      respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
        acknowledged = true;
        if (ok && !terminalTalkChatSendAckError(result)) {
          const candidateRunId = asNullableRecord(result)?.runId;
          const runId = typeof candidateRunId === "string" ? candidateRunId : idempotencyKey;
          try {
            if (params.relaySessionId && params.connId) {
              registerTalkRealtimeRelayAgentRun({
                relaySessionId: params.relaySessionId,
                connId: params.connId,
                sessionKey: params.sessionTarget.canonicalKey,
                runId,
                callId: params.callId,
              });
            }
            params.onRunStarted?.(runId);
            acknowledgedRunId = runId;
          } catch (registrationError) {
            abortChatRunById(request.context, {
              runId,
              sessionKey: params.sessionTarget.canonicalKey,
              stopReason: "voice session binding failed",
            });
            resolve({
              ok: false,
              error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(registrationError)),
            });
            return;
          }
        }
        resolve(
          ok
            ? { ok: true, result }
            : {
                ok: false,
                error:
                  error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
              },
        );
      },
    } satisfies GatewayRequestHandlerOptions;
    // Speech owns reusable history; keep consult scaffolding only in the lossless archive.
    const chatSendResult = handleTrustedInternalChatSend(chatSendOptions, undefined, {
      toolsAllow: authority.toolsAllow,
      transcript: { display: false, excludeFromContext: true },
      prepareAssistantTranscriptMessage: prepareTalkAgentConsultTranscript,
    });
    void Promise.resolve(chatSendResult).then(
      () => {
        if (!acknowledged) {
          resolve(undefined);
        }
      },
      (error: unknown) => {
        if (acknowledged) {
          request.context.logGateway.warn(
            `realtime Talk agent consult failed after acknowledgement: ${formatForLog(error)}`,
          );
          return;
        }
        resolve({
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)),
        });
      },
    );
  });

  if (!chatResponse) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result"),
    };
  }
  if (!chatResponse.ok) {
    return { ok: false, error: chatResponse.error };
  }
  const terminalAckError = terminalTalkChatSendAckError(chatResponse.result);
  if (terminalAckError) {
    return { ok: false, error: terminalAckError };
  }
  if (!acknowledgedRunId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not acknowledge an active run"),
    };
  }
  return { ok: true, runId: acknowledgedRunId, idempotencyKey };
}
