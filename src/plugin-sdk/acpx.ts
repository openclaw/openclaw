// Private ACPX runtime backend implementation.
// The public ACP runtime and shipped compatibility facade project this narrow owner surface.

import { getBoundLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigOptionResult,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "@openclaw/acp-core/runtime/types";

// Standalone SDK calls retain their shipped process-native lazy runtime.
const dispatch = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../auto-reply/reply/dispatch-acp-sdk.js")),
  (runtime) => runtime.tryDispatchAcpReplyHookCore,
);

/** Dispatch an ACP hook through its exact request host before loading native stateful code. */
export async function tryDispatchAcpReplyHook(
  event: PluginHookReplyDispatchEvent,
  ctx: PluginHookReplyDispatchContext,
): Promise<PluginHookReplyDispatchResult | void> {
  const host = getBoundLegacyPluginSdkResourceHost();
  return host
    ? host.invokeReplyDispatch((reply) => reply.tryDispatchAcpReplyHook(event, ctx))
    : dispatch(event, ctx);
}
