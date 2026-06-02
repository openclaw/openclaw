import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type ResolveNativeCommandSessionTargetsParams = {
  /** Agent runtime that owns the synthetic ad hoc session key. */
  agentId: string;
  /** Channel/native-command namespace for sessions that are not already bound. */
  sessionPrefix: string;
  /** Channel user identity used only when synthesizing an ad hoc session key. */
  userId: string;
  /** Routed conversation/session that should receive command results when no binding exists. */
  targetSessionKey: string;
  /** Existing ACP/native binding; when present it owns both resume identity and delivery target. */
  boundSessionKey?: string;
  /** Some channel adapters already lower-case session ids before persistence. */
  lowercaseSessionKey?: boolean;
};

/** Resolve the session key pair used to execute native commands in bound or ad hoc sessions. */
export function resolveNativeCommandSessionTargets(
  params: ResolveNativeCommandSessionTargetsParams,
) {
  // Bound native sessions must keep both keys identical so follow-up native
  // commands resume the same ACP binding instead of jumping back to the routed
  // channel conversation.
  const rawSessionKey =
    params.boundSessionKey ?? `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`;
  return {
    sessionKey: params.lowercaseSessionKey
      ? normalizeLowercaseStringOrEmpty(rawSessionKey)
      : rawSessionKey,
    commandTargetSessionKey: params.boundSessionKey ?? params.targetSessionKey,
  };
}
