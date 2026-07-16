// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import {
  testing as managerTesting,
  getAcpSessionManager as getInternalAcpSessionManager,
  type AcpCloseSessionInput,
  type AcpCloseSessionResult,
  type AcpInitializeSessionInput,
  type AcpManagerObservabilitySnapshot,
  type AcpRunTurnInput,
  type AcpSessionManager as InternalAcpSessionManager,
  type AcpSessionResolution,
  type AcpSessionRuntimeOptions,
  type AcpSessionStatus,
  type AcpStartupIdentityReconcileResult,
} from "../acp/control-plane/manager.js";
import { testing as registryTesting } from "../acp/runtime/registry.js";
import {
  readAcpSessionEntry as readInternalAcpSessionEntry,
  type AcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import type { InternalSessionEntry } from "../config/sessions/main-session-recovery.types.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectPluginSessionEntry } from "../plugins/runtime/session-store-facade.js";

/** Public ACP manager methods exposed without the internal class instance or dependencies. */
export interface AcpSessionManagerFacade {
  resolveSession(params: { cfg: OpenClawConfig; sessionKey: string }): AcpSessionResolution;
  getObservabilitySnapshot(cfg: OpenClawConfig): AcpManagerObservabilitySnapshot;
  reconcilePendingSessionIdentities(params: {
    cfg: OpenClawConfig;
  }): Promise<AcpStartupIdentityReconcileResult>;
  initializeSession(input: AcpInitializeSessionInput): Promise<{
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }>;
  getSessionStatus(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus>;
  setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions>;
  setSessionConfigOption(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions>;
  updateSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions>;
  resetSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<AcpSessionRuntimeOptions>;
  runTurn(input: AcpRunTurnInput): Promise<void>;
  cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason?: string;
  }): Promise<void>;
  closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult>;
}

const pluginAcpManagerFacades = new WeakMap<InternalAcpSessionManager, AcpSessionManagerFacade>();

function projectAcpSessionStoreEntry(
  storeEntry: AcpSessionStoreEntry | null,
): AcpSessionStoreEntry | null {
  if (!storeEntry?.entry) {
    return storeEntry;
  }
  return {
    ...storeEntry,
    entry: projectPluginSessionEntry(storeEntry.entry as InternalSessionEntry),
  };
}

/** Reads ACP metadata while keeping core-only session coordination private. */
export function readAcpSessionEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  clone?: boolean;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionStoreEntry | null {
  return projectAcpSessionStoreEntry(readInternalAcpSessionEntry(params));
}

/**
 * Returns a stable, frozen facade over the ACP manager.
 *
 * The facade deliberately has no internal class identity or prototype so plugins cannot bypass
 * the session projection boundary through the manager constructor.
 */
export function getAcpSessionManager(): AcpSessionManagerFacade {
  const manager = getInternalAcpSessionManager();
  const existing = pluginAcpManagerFacades.get(manager);
  if (existing) {
    return existing;
  }
  const resolveSession: AcpSessionManagerFacade["resolveSession"] = (params) => {
    const resolved = manager.resolveSession(params);
    if (resolved.kind !== "ready" || !resolved.entry) {
      return resolved;
    }
    return {
      ...resolved,
      entry: projectPluginSessionEntry(resolved.entry as InternalSessionEntry),
    };
  };
  const facade = {
    resolveSession,
    getObservabilitySnapshot: manager.getObservabilitySnapshot.bind(manager),
    reconcilePendingSessionIdentities: manager.reconcilePendingSessionIdentities.bind(manager),
    initializeSession: manager.initializeSession.bind(manager),
    getSessionStatus: manager.getSessionStatus.bind(manager),
    setSessionRuntimeMode: manager.setSessionRuntimeMode.bind(manager),
    setSessionConfigOption: manager.setSessionConfigOption.bind(manager),
    updateSessionRuntimeOptions: manager.updateSessionRuntimeOptions.bind(manager),
    resetSessionRuntimeOptions: manager.resetSessionRuntimeOptions.bind(manager),
    runTurn: manager.runTurn.bind(manager),
    cancelSession: manager.cancelSession.bind(manager),
    closeSession: manager.closeSession.bind(manager),
  } satisfies AcpSessionManagerFacade;
  Object.setPrototypeOf(facade, null);
  Object.freeze(facade);
  pluginAcpManagerFacades.set(manager, facade);
  return facade;
}

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
export type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
export { tryDispatchAcpReplyHook } from "./acp-runtime-backend.js";

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
