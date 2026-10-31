import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../config/sessions/session-entry-current-check.js";
// Bundled runtime authority for selected sessions and conversation bindings.
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type PreparedSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { guardAcpBindingPlatformSend } from "../infra/outbound/acp-binding-authority.js";
import { projectPluginSessionEntry } from "./session-store-runtime-internal.js";

export type { PreparedSessionSourceAssertion } from "../config/sessions/session-source-authority.js";

/** Read current policy in the worker at effects; pass source to worker-backed mutations. */
export async function captureSessionEntryCurrentCheckAsync(
  params: Parameters<typeof captureSessionEntryCurrentCheckAsyncInternal>[0],
) {
  const prepared = await captureSessionEntryCurrentCheckAsyncInternal(params);
  return {
    ...prepared,
    entry: prepared.entry ? projectPluginSessionEntry(prepared.entry) : undefined,
  };
}

/** Compose prepared sources; opaque source callbacks retain native transaction visibility. */
export function composeSessionEntryCommitGuards(
  sources: readonly ((() => void) | undefined)[],
  /** Bundled live-authority wrapper; opaque SDK predicates belong in sources. */
  checkHostAuthority?: (assertSources: () => void) => void,
): PreparedSessionSourceAssertion {
  return composeSessionSourceAssertion(
    sources.map(captureExternalSessionCommitGuard),
    checkHostAuthority,
  );
}

export {
  testing as __testing,
  testing,
  getSessionBindingService,
  inspectSessionBindingByConversation,
  registerSessionBindingAdapter,
  registerSessionBindingAdapterV2,
  type SessionBindingRecord,
  type SessionBindingAdapterV2,
  type SessionBindingSelectionSnapshot,
  type SessionBindingService,
  type AsyncSessionBindingService,
  type SessionBindingServiceV2,
} from "../infra/outbound/session-binding-service.js";

/**
 * Native channel sends: re-check an ACP child reply's conversation binding right
 * before each platform send, after any async media load. No-op for other replies.
 */
export function guardAcpBoundReplyPlatformSend(
  payload: object,
  onPlatformSendDispatch?: () => Promise<void>,
): (() => Promise<void>) | undefined {
  return guardAcpBindingPlatformSend(
    getReplyPayloadMetadata(payload)?.acpBindingAuthority,
    onPlatformSendDispatch,
  );
}
