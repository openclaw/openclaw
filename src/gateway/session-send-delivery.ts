import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SessionSendDeliveryEndpoint = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};

/** Live communication facts identify an accepted input without durable restart custody. */
export type SessionSendDelivery = {
  version: 1;
  runId: string;
  source: SessionSendDeliveryEndpoint;
  target: SessionSendDeliveryEndpoint;
  sandboxed: boolean;
  message: string;
  /** Returned results owe no new reply; retain their host-authored intake instructions. */
  returnedResult?: { extraSystemPrompt: string };
};

type Admission = { delivery: SessionSendDelivery };
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionSendDeliveryAdmission"),
  () => new AsyncLocalStorage<Admission | undefined>(),
);

/** Only the in-process communication owner may attach live delivery facts. */
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
