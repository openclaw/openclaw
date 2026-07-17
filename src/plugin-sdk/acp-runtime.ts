// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import { testing as managerTesting, getAcpSessionManager } from "../acp/control-plane/manager.js";
import { testing as registryTesting } from "../acp/runtime/registry.js";
import {
  readAcpSessionEntry as readInternalAcpSessionEntry,
  type AcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { projectPluginSessionEntry } from "../plugins/runtime/session-store-facade.js";

export { getAcpSessionManager };
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
export type { AcpSessionStoreEntry };
export { tryDispatchAcpReplyHook } from "./acp-runtime-backend.js";

/** Reads ACP metadata through the public plugin session projection. */
export function readAcpSessionEntry(
  params: Parameters<typeof readInternalAcpSessionEntry>[0],
): AcpSessionStoreEntry | null {
  const result = readInternalAcpSessionEntry(params);
  if (!result?.entry) {
    return result;
  }
  return {
    ...result,
    entry: projectPluginSessionEntry(result.entry as InternalSessionEntry),
  };
}

// Keep test helpers off the hot init path. Eagerly merging them here can
// create a back-edge through the bundled ACP runtime chunk before the imported
// testing bindings finish initialization.
/** Lazy ACP test helper facade combining control-plane and runtime registry helpers. */
export const testing = new Proxy({} as typeof managerTesting & typeof registryTesting, {
  get(_target, prop, receiver) {
    if (Reflect.has(managerTesting, prop)) {
      return Reflect.get(managerTesting, prop, receiver);
    }
    return Reflect.get(registryTesting, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop);
  },
  ownKeys() {
    return Array.from(
      new Set([...Reflect.ownKeys(managerTesting), ...Reflect.ownKeys(registryTesting)]),
    );
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }
    return undefined;
  },
});

/** @deprecated Use `testing`. */
export { testing as __testing };
