import type { InheritedToolPolicyV2 } from "../agents/inherited-tool-policy.schema.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import type { DispatchGatewayMethodInProcessOptions } from "./server-plugin-in-process-dispatch.types.js";

/** Admission facts captured by the host, separate from model-authored request parameters. */
export type SessionSendPolicyAdmission = Readonly<
  {
    policy: InheritedToolPolicyV2;
  } & (
    | { kind: "delegation"; assertCurrent?: () => void }
    | { kind: "recovery"; assertCurrent: () => void }
  )
>;

const admissions = resolveGlobalSingleton<WeakMap<object, SessionSendPolicyAdmission>>(
  Symbol.for("openclaw.inProcessSessionSendPolicies"),
  () => new WeakMap(),
);

export function bindInProcessSessionSendPolicy<T extends object>(
  carrier: T,
  admission: SessionSendPolicyAdmission | undefined,
): T {
  if (admission) {
    admissions.set(carrier, admission);
  }
  return carrier;
}

export function readInProcessSessionSendPolicy(
  carrier: object | null | undefined,
): SessionSendPolicyAdmission | undefined {
  return carrier ? admissions.get(carrier) : undefined;
}

export function transferInProcessSessionSendPolicy(
  method: string,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  client: NonNullable<GatewayRequestOptions["client"]>,
): void {
  const admission = readInProcessSessionSendPolicy(options);
  if (!admission) {
    return;
  }
  if (method !== "agent" || options?.forceSyntheticClient !== true || !client.internal) {
    throw new Error("Delegated session input requires a synthetic agent admission.");
  }
  admission.assertCurrent?.();
  bindInProcessSessionSendPolicy(client.internal, admission);
}
