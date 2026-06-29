import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  type CanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";

const log = createSubsystemLogger("outbound/message-sent");

export type EmitCanonicalMessageSentParams = {
  /** Canonical sent-message context (built via buildCanonicalSentMessageHookContext). */
  canonical: CanonicalSentMessageHookContext;
  /**
   * Session key used to fire the internal `message:sent` hook. When absent, only
   * the `message_sent` plugin hook can fire (the internal hook is skipped).
   */
  sessionKeyForInternalHooks?: string;
  /** Hook runner to use; defaults to the global runner when omitted. */
  hookRunner?: ReturnType<typeof getGlobalHookRunner> | null;
};

/**
 * Single source of truth for emitting the canonical "message sent" signal:
 *   1. the `message_sent` plugin hook (`hookRunner.runMessageSent`), and
 *   2. the internal `message:sent` hook (`action === "sent"`), gated on a session key.
 *
 * Both the explicit outbound path (`createMessageSentEmitter` in deliver.ts) and
 * the extension-facing delivery-report seam (`reportOutboundDelivered`) route
 * through here so the two emission sites can never drift in hook order or gating.
 *
 * Fail-open: hook execution is fire-and-forget; failures are logged, not thrown.
 *
 * @internal — core/SDK use only. Extensions MUST go through
 * `reportOutboundDelivered` (openclaw/plugin-sdk/outbound-delivery-report), never
 * this function directly, so the hook-emission machinery stays unexposed.
 */
export function emitCanonicalMessageSent(params: EmitCanonicalMessageSentParams): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  if (!hasMessageSentHooks && !canEmitInternalHook) {
    return;
  }
  const canonical = params.canonical;
  if (hasMessageSentHooks) {
    fireAndForgetHook(
      hookRunner!.runMessageSent(
        toPluginMessageSentEvent(canonical),
        toPluginMessageContext(canonical),
      ),
      "emitCanonicalMessageSent: message_sent plugin hook failed",
      (message) => {
        log.warn(message);
      },
    );
  }
  if (!canEmitInternalHook) {
    return;
  }
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks!,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "emitCanonicalMessageSent: message:sent internal hook failed",
    (message) => {
      log.warn(message);
    },
  );
}
