import {
  captureSessionEntryCurrentCheckInternal,
  captureSessionEntryCurrentCheckAsyncInternal,
} from "../config/sessions/session-entry-current-check.js";
// Bundled runtime authority for selected sessions and conversation bindings.
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type PreparedSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { projectPluginSessionEntry } from "./session-store-runtime-internal.js";

/** @deprecated Use captureSessionEntryCurrentCheckAsync; removed in the next Plugin SDK major. */
export async function captureSessionEntryCurrentCheck(
  params: Parameters<typeof captureSessionEntryCurrentCheckInternal>[0],
) {
  warnPluginSdkDeprecation({
    family: "session-currentness",
    method: "captureSessionEntryCurrentCheck",
    replacement: "captureSessionEntryCurrentCheckAsync",
  });
  const prepared = await captureSessionEntryCurrentCheckInternal(params);
  return {
    ...prepared,
    entry: prepared.entry ? projectPluginSessionEntry(prepared.entry) : undefined,
  };
}

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
