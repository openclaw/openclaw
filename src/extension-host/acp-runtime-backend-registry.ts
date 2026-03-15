import { AcpRuntimeError } from "../acp/runtime/errors.js";
import type { AcpRuntime } from "../acp/runtime/types.js";

export type ExtensionHostAcpRuntimeBackend = {
  id: string;
  runtime: AcpRuntime;
  healthy?: () => boolean;
};

type ExtensionHostAcpRuntimeRegistryGlobalState = {
  backendsById: Map<string, ExtensionHostAcpRuntimeBackend>;
};

const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");

function createExtensionHostAcpRuntimeRegistryGlobalState(): ExtensionHostAcpRuntimeRegistryGlobalState {
  return {
    backendsById: new Map<string, ExtensionHostAcpRuntimeBackend>(),
  };
}

function resolveExtensionHostAcpRuntimeRegistryGlobalState(): ExtensionHostAcpRuntimeRegistryGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [ACP_RUNTIME_REGISTRY_STATE_KEY]?: ExtensionHostAcpRuntimeRegistryGlobalState;
  };
  if (!runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY]) {
    runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY] =
      createExtensionHostAcpRuntimeRegistryGlobalState();
  }
  return runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY];
}

const EXTENSION_HOST_ACP_BACKENDS_BY_ID =
  resolveExtensionHostAcpRuntimeRegistryGlobalState().backendsById;

function normalizeBackendId(id: string | undefined): string {
  return id?.trim().toLowerCase() || "";
}

function isBackendHealthy(backend: ExtensionHostAcpRuntimeBackend): boolean {
  if (!backend.healthy) {
    return true;
  }
  try {
    return backend.healthy();
  } catch {
    return false;
  }
}

export function registerExtensionHostAcpRuntimeBackend(
  backend: ExtensionHostAcpRuntimeBackend,
): void {
  const id = normalizeBackendId(backend.id);
  if (!id) {
    throw new Error("ACP runtime backend id is required");
  }
  if (!backend.runtime) {
    throw new Error(`ACP runtime backend "${id}" is missing runtime implementation`);
  }
  EXTENSION_HOST_ACP_BACKENDS_BY_ID.set(id, {
    ...backend,
    id,
  });
}

export function unregisterExtensionHostAcpRuntimeBackend(id: string): void {
  const normalized = normalizeBackendId(id);
  if (!normalized) {
    return;
  }
  EXTENSION_HOST_ACP_BACKENDS_BY_ID.delete(normalized);
}

export function getExtensionHostAcpRuntimeBackend(
  id?: string,
): ExtensionHostAcpRuntimeBackend | null {
  const normalized = normalizeBackendId(id);
  if (normalized) {
    return EXTENSION_HOST_ACP_BACKENDS_BY_ID.get(normalized) ?? null;
  }
  if (EXTENSION_HOST_ACP_BACKENDS_BY_ID.size === 0) {
    return null;
  }
  for (const backend of EXTENSION_HOST_ACP_BACKENDS_BY_ID.values()) {
    if (isBackendHealthy(backend)) {
      return backend;
    }
  }
  return EXTENSION_HOST_ACP_BACKENDS_BY_ID.values().next().value ?? null;
}

export function requireExtensionHostAcpRuntimeBackend(id?: string): ExtensionHostAcpRuntimeBackend {
  const normalized = normalizeBackendId(id);
  const backend = getExtensionHostAcpRuntimeBackend(normalized || undefined);
  if (!backend) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
    );
  }
  if (!isBackendHealthy(backend)) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNAVAILABLE",
      "ACP runtime backend is currently unavailable. Try again in a moment.",
    );
  }
  if (normalized && backend.id !== normalized) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      `ACP runtime backend "${normalized}" is not registered.`,
    );
  }
  return backend;
}

export const __testing = {
  resetExtensionHostAcpRuntimeBackendsForTests() {
    EXTENSION_HOST_ACP_BACKENDS_BY_ID.clear();
  },
  getExtensionHostAcpRuntimeRegistryGlobalStateForTests() {
    return resolveExtensionHostAcpRuntimeRegistryGlobalState();
  },
};
