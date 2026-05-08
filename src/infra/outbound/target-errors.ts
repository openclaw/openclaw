/**
 * Tagged error indicating that an outbound dispatch failed terminally — the
 * caller has been (or will be) informed that the send did not happen, and the
 * delivery should NOT be replayed by `delivery-recovery` after a gateway
 * restart.
 *
 * Use this for predictable pre-flight failures (e.g. "channel listener is
 * down, login first"), not for crashes mid-send. Crashes mid-send still go
 * through the normal failDelivery path so recovery can replay them.
 *
 * Detection across module boundaries uses `error.name === "OutboundDispatchTerminalError"`,
 * see `isOutboundDispatchTerminalError`.
 */
export class OutboundDispatchTerminalError extends Error {
  override readonly name = "OutboundDispatchTerminalError";
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Detect a terminal outbound dispatch error across module boundaries.
 *
 * Plugins (e.g. WhatsApp) raise the error from their own bundle, so an
 * `instanceof` check would fail when the prototype lives in a separate copy of
 * the module graph; we match on `error.name` instead, which is set on the
 * class itself.
 */
export function isOutboundDispatchTerminalError(
  err: unknown,
): err is OutboundDispatchTerminalError {
  if (err instanceof OutboundDispatchTerminalError) {
    return true;
  }
  return (
    err instanceof Error &&
    err.name === "OutboundDispatchTerminalError" &&
    typeof (err as { reason?: unknown }).reason === "string"
  );
}

export function missingTargetMessage(provider: string, hint?: string): string {
  return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}

export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}

export function ambiguousTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}

export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(ambiguousTargetMessage(provider, raw, hint));
}

export function unknownTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}

export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(unknownTargetMessage(provider, raw, hint));
}

function formatTargetHint(hint?: string, withLabel = false): string {
  const normalized = hint?.trim();
  if (!normalized) {
    return "";
  }
  return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
