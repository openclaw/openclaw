import type { AcpConversationBindingAuthority } from "./acp-binding-authority.types.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { getSessionBindingService } from "./session-binding-service.js";

export type { AcpConversationBindingAuthority };

/** Whether the conversation is still bound to the same child by the same binding. */
export async function isAcpConversationBindingCurrent(
  authority: AcpConversationBindingAuthority,
): Promise<boolean> {
  const current = await getSessionBindingService()
    .resolveByConversationAsync(authority.conversation)
    .catch(() => null);
  return (
    current?.bindingId === authority.bindingId &&
    current.boundAt === authority.boundAt &&
    current.targetSessionKey === authority.targetSessionKey
  );
}

/** Rejects a recovered send whose ACP conversation binding was removed or reassigned. */
export async function assertAcpConversationBindingCurrent(
  authority: AcpConversationBindingAuthority | undefined,
): Promise<void> {
  if (authority && !(await isAcpConversationBindingCurrent(authority))) {
    throw new PlatformMessageNotDispatchedError("ACP conversation binding was revoked", {
      cause: undefined,
      retryable: false,
    });
  }
}

/**
 * Wraps a native platform-send hook so an ACP child reply re-checks its binding
 * at each transport handoff (after async media loads), failing closed.
 */
export function guardAcpBindingPlatformSend(
  authority: AcpConversationBindingAuthority | undefined,
  onPlatformSendDispatch?: () => Promise<void>,
): (() => Promise<void>) | undefined {
  if (!authority) {
    return onPlatformSendDispatch;
  }
  return async () => {
    await assertAcpConversationBindingCurrent(authority);
    await onPlatformSendDispatch?.();
  };
}

// Enumerable so the selection survives context spreads; never serialized into payloads.
const GATHERED_ACP_BINDING = Symbol.for("openclaw.gatheredAcpConversationBinding");
type GatheredCarrier = {
  SessionKey?: string;
  [GATHERED_ACP_BINDING]?: AcpConversationBindingAuthority;
};

/** Retains the binding that routed this turn to an ACP child at gather time. */
export function retainGatheredAcpBinding(
  ctx: GatheredCarrier,
  authority: AcpConversationBindingAuthority,
): void {
  ctx[GATHERED_ACP_BINDING] = { ...authority, conversation: { ...authority.conversation } };
}

export function readGatheredAcpBinding(
  ctx: GatheredCarrier,
): AcpConversationBindingAuthority | undefined {
  return ctx[GATHERED_ACP_BINDING];
}
