import { captureSessionEntryCurrentCheckInternal } from "../config/sessions/session-entry-current-check.js";
// Bundled runtime authority for selected sessions and conversation bindings.
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { projectPluginSessionEntry } from "./session-store-runtime-internal.js";

/** Prepare public metadata together with its original source and exact live policy guard. */
export async function captureSessionEntryCurrentCheck(
  params: Parameters<typeof captureSessionEntryCurrentCheckInternal>[0],
) {
  const prepared = await captureSessionEntryCurrentCheckInternal(params);
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
): () => void {
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
  type SessionBindingRecord,
  type SessionBindingService,
  type AsyncSessionBindingService,
} from "../infra/outbound/session-binding-service.js";
