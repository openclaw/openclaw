import { writeSync } from "node:fs";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { resolveEnabledDebugProxySettings, type DebugProxySettings } from "./env.js";
import { REDACTED_CAPTURE_HEADER_VALUE } from "./header-redaction.js";
import { registerCaptureStoreFinalizer } from "./store-lifecycle.js";
import { getDebugProxyCaptureStore, persistEventPayload, safeJsonString } from "./store.sqlite.js";

const DEBUG_PROXY_FETCH_PATCH_KEY = Symbol.for("openclaw.debugProxy.fetchPatch");

type DebugProxyCaptureStoreLike = Pick<
  ReturnType<typeof getDebugProxyCaptureStore>,
  "upsertSession" | "endSession" | "recordEvent"
> &
  Partial<Pick<ReturnType<typeof getDebugProxyCaptureStore>, "close" | "isClosed">>;

export type DebugProxyCaptureRuntimeDeps = {
  getStore?: () => DebugProxyCaptureStoreLike;
  closeStore?: () => void;
  persistEventPayload?: (
    store: DebugProxyCaptureStoreLike,
    payload: Parameters<typeof persistEventPayload>[1],
  ) => ReturnType<typeof persistEventPayload>;
  safeJsonString?: typeof safeJsonString;
  fetchTarget?: typeof globalThis;
};

export function resolveRuntimeDeps(deps: DebugProxyCaptureRuntimeDeps = {}) {
  return {
    getStore: deps.getStore ?? getDebugProxyCaptureStore,
    closeStore: deps.closeStore,
    persistEventPayload:
      deps.persistEventPayload ??
      ((store, payload) =>
        // SAFETY: The default writer receives real stores; lightweight test stores supply their own writer.
        persistEventPayload(store as ReturnType<typeof getDebugProxyCaptureStore>, payload)),
    safeJsonString: deps.safeJsonString ?? safeJsonString,
    fetchTarget: deps.fetchTarget ?? globalThis,
  };
}

export type CaptureOwner = {
  settings: DebugProxySettings;
  runtime: ReturnType<typeof resolveRuntimeDeps>;
  store: DebugProxyCaptureStoreLike;
  active: boolean;
  pending: Set<() => void>;
  errors: unknown[];
  unregister: () => void;
  admission: CaptureAdmission;
};
type CaptureAdmission = { current?: CaptureOwner };
type CaptureRegistry = {
  owners: Map<string, CaptureOwner>;
  resolved: WeakMap<DebugProxySettings, CaptureAdmission>;
  ambient?: { sessionId: string; dbPath: string; admission: CaptureAdmission };
};
const captureOwners = new WeakMap<
  ReturnType<typeof resolveRuntimeDeps>["getStore"],
  CaptureRegistry
>();

type GlobalFetchPatchedState = {
  originalFetch: typeof globalThis.fetch;
  admission: CaptureAdmission;
};

type GlobalFetchPatchTarget = typeof globalThis & {
  [DEBUG_PROXY_FETCH_PATCH_KEY]?: GlobalFetchPatchedState;
};

const globalFetchPatches = new WeakMap<typeof globalThis.fetch, GlobalFetchPatchedState>();

/** Guarded requests own capture admission, including when given a saved patch. */
export function resolveDebugProxyFetchTransport(
  fetchImpl: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return globalFetchPatches.get(fetchImpl)?.originalFetch ?? fetchImpl;
}

export function hasDebugProxyFetchPatch(
  fetchTarget: GlobalFetchPatchTarget,
  admission: CaptureAdmission,
): boolean {
  return fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]?.admission === admission;
}

/** Keep wrapper identity and its admission together for matching-owner teardown. */
export function registerDebugProxyFetchPatch(
  fetchTarget: GlobalFetchPatchTarget,
  originalFetch: typeof globalThis.fetch,
  patchedFetch: typeof globalThis.fetch,
  admission: CaptureAdmission,
): void {
  const patch = { originalFetch, admission };
  fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY] = patch;
  globalFetchPatches.set(patchedFetch, patch);
  fetchTarget.fetch = patchedFetch;
}

export function uninstallDebugProxyGlobalFetchPatch(
  deps: DebugProxyCaptureRuntimeDeps = {},
  admission?: CaptureAdmission,
): void {
  const fetchTarget: GlobalFetchPatchTarget = resolveRuntimeDeps(deps).fetchTarget;
  const state = fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
  if (!state || (admission && state.admission !== admission)) {
    return;
  }
  fetchTarget.fetch = state.originalFetch;
  delete fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
}

export function isDebugProxyGlobalFetchPatchInstalled(): boolean {
  const fetchTarget: GlobalFetchPatchTarget = globalThis;
  return Boolean(fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]);
}

function captureOwnerKey(settings: DebugProxySettings): string {
  // dbPath is the root-derived capture locator, not the shared database route.
  // Implicit session IDs survive state-root changes, so both identify an owner.
  return JSON.stringify([settings.dbPath, settings.sessionId]);
}

export function reportCapturePersistenceFailure(owner: CaptureOwner, error: unknown): void {
  owner.errors.push(error);
  // The earlier SQLite exit hook swallows close errors. Report synchronously
  // here before it closes the store; diagnostics must not interrupt settlement.
  try {
    const message = redactRegisteredSecretValues(
      error instanceof Error ? error.message : String(error),
      () => REDACTED_CAPTURE_HEADER_VALUE,
    );
    writeSync(2, `[proxy-capture] Capture persistence failed: ${message}\n`);
  } catch {
    // Preserve the original failure even if the diagnostic sink is unavailable.
  }
}

function finishCaptureOwner(owner: CaptureOwner): void {
  if (!owner.active) {
    return;
  }
  owner.active = false;
  owner.admission.current = undefined;
  const registry = captureOwners.get(owner.runtime.getStore)!;
  registry.owners.delete(captureOwnerKey(owner.settings));
  uninstallDebugProxyGlobalFetchPatch(owner.runtime, owner.admission);
  owner.unregister();
  for (const finish of owner.pending) {
    finish();
  }
  try {
    if (!owner.store.isClosed) {
      owner.store.endSession(owner.settings.sessionId);
    }
  } catch (error) {
    reportCapturePersistenceFailure(owner, error);
  }
  if (owner.errors.length) {
    throw new AggregateError(owner.errors.splice(0), "Capture session finalization failed.");
  }
}

export function resolveCaptureOwner(
  settings: DebugProxySettings,
  runtime: ReturnType<typeof resolveRuntimeDeps>,
  options: { initialize?: boolean; explicit?: boolean } = {},
): CaptureOwner | undefined {
  let registry = captureOwners.get(runtime.getStore);
  if (!registry) {
    registry = { owners: new Map(), resolved: new WeakMap() };
    captureOwners.set(runtime.getStore, registry);
  }
  const key = captureOwnerKey(settings);
  let owner = registry.owners.get(key);
  if (!owner) {
    // Explicit settings own their lifetime; ambient capture observes current
    // configuration. Keep only its current marker, not retired IDs or stores.
    const prior = options.explicit
      ? registry.resolved.get(settings)
      : registry.ambient?.sessionId === settings.sessionId &&
          registry.ambient.dbPath === settings.dbPath
        ? registry.ambient.admission
        : undefined;
    if (!options.initialize && prior) {
      return prior.current;
    }
    const store = runtime.getStore();
    if (store.isClosed) {
      return undefined;
    }
    owner = {
      settings,
      runtime,
      store,
      active: true,
      pending: new Set(),
      errors: [],
      unregister: () => {},
      admission: {},
    };
    owner.admission.current = owner;
    const retainedOwner = owner;
    owner.unregister = registerCaptureStoreFinalizer(store, () =>
      finishCaptureOwner(retainedOwner),
    );
    registry.owners.set(key, owner);
  }
  if (options.explicit) {
    registry.resolved.set(settings, owner.admission);
  } else {
    registry.ambient = {
      sessionId: settings.sessionId,
      dbPath: settings.dbPath,
      admission: owner.admission,
    };
  }
  return owner;
}

// Finalization closes the session and restores the fetch patch before closing
// the cached store, preventing later normal requests from being captured.
export function finalizeDebugProxyCapture(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  const owner = captureOwners.get(runtime.getStore)?.owners.get(captureOwnerKey(settings));
  if (owner) {
    uninstallDebugProxyGlobalFetchPatch(deps, owner.admission);
  }
  if (!owner?.active) {
    return;
  }
  const errors: unknown[] = [];
  try {
    finishCaptureOwner(owner);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (owner.runtime.closeStore) {
      owner.runtime.closeStore();
    } else {
      owner.store.close?.();
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "Capture finalization failed.");
  }
}
