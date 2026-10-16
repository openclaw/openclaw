import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SessionSendDeliveryEndpoint = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};

/** Durable facts identify an accepted input; they never restore the sender's run authority. */
export type SessionSendDelivery = {
  version: 1;
  runId: string;
  source: SessionSendDeliveryEndpoint;
  target: SessionSendDeliveryEndpoint;
  sandboxed: boolean;
  message: string;
};

type Admission = { delivery: SessionSendDelivery; acceptedMessage?: PersistedUserTurnMessage };
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionSendDeliveryAdmission"),
  () => new AsyncLocalStorage<Admission | undefined>(),
);

/** Only the in-process communication owner may attach durable delivery facts. */
export function withSessionSendDelivery<T>(value: Admission, run: () => T): T {
  return admission.run(value, run);
}

/** Carry invocation-time delivery facts through a previously captured caller context. */
export function bindSessionSendDeliveryContext<T>(run: () => T): () => T {
  const value = admission.getStore();
  return () => admission.run(value, run);
}

export function readSessionSendDeliveryAdmission(params: {
  runId: string;
  sessionKey?: string;
  sessionId: string;
  agentId: string;
}): Admission | undefined {
  const value = admission.getStore();
  return value?.delivery.runId === params.runId &&
    value.delivery.target.sessionKey === params.sessionKey &&
    value.delivery.target.sessionId === params.sessionId &&
    value.delivery.target.agentId === params.agentId
    ? value
    : undefined;
}

export function readSessionSendDelivery(
  message: PersistedUserTurnMessage,
): (SessionSendDelivery & { operatorSource?: unknown }) | undefined {
  const value = message["__openclaw"]?.sessionSendDelivery;
  const endpoint = (entry: unknown): entry is SessionSendDeliveryEndpoint =>
    isRecord(entry) &&
    typeof entry.agentId === "string" &&
    typeof entry.sessionKey === "string" &&
    typeof entry.sessionId === "string" &&
    (entry.lifecycleRevision === undefined || typeof entry.lifecycleRevision === "string");
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.message !== "string" ||
    typeof value.sandboxed !== "boolean" ||
    !endpoint(value.source) ||
    !endpoint(value.target) ||
    message.provenance?.kind !== "inter_session" ||
    message.provenance.sourceTool !== "sessions_send" ||
    message.provenance.sourceSessionKey !== value.source.sessionKey ||
    message.idempotencyKey !== `${value.runId}:user`
  ) {
    return undefined;
  }
  return {
    version: 1,
    runId: value.runId,
    source: value.source,
    target: value.target,
    sandboxed: value.sandboxed,
    message: value.message,
    // The operator recovery owner validates its own bounded representation.
    operatorSource: value.operatorSource,
  };
}
