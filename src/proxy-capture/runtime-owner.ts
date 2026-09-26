import { writeSync } from "node:fs";
import { serialize } from "node:v8";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { reserveSqliteWorkerInputPreparation } from "../infra/sqlite-worker-store.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveEnabledDebugProxySettings, type DebugProxySettings } from "./env.js";
import { REDACTED_CAPTURE_HEADER_VALUE } from "./header-redaction.js";
import { registerActiveDebugProxyCapture } from "./runtime-cleanup.js";
import {
  registerCaptureStoreFinalizer,
  registerAsyncCaptureStoreFinalizer,
} from "./store-lifecycle.js";
import {
  createDebugProxyCaptureStoreForContext,
  type AsyncDebugProxyCaptureStore,
} from "./store.async.js";
import { getDebugProxyCaptureStore, persistEventPayload, safeJsonString } from "./store.sqlite.js";
import type { CapturePayloadInput } from "./store.worker-contract.js";
import type { CaptureEventRecord } from "./types.js";

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

export type DebugProxyCaptureAsyncRuntimeDeps = Pick<
  DebugProxyCaptureRuntimeDeps,
  "safeJsonString" | "fetchTarget"
>;

type CaptureStateContext =
  | { context: ReturnType<typeof captureOpenClawStateWorkerContext> }
  | { error: unknown };

function captureStateContext(): CaptureStateContext {
  try {
    return { context: captureOpenClawStateWorkerContext() };
  } catch (error) {
    return { error };
  }
}

function currentStateContext(owner: CaptureOwner) {
  if ("error" in owner.state) {
    throw owner.state.error;
  }
  owner.state.context.admission.assertCurrent();
  return owner.state.context;
}

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
  session: CaptureSession;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  settings: DebugProxySettings;
  runtime: ReturnType<typeof resolveRuntimeDeps>;
  store: DebugProxyCaptureStoreLike;
  syncStore?: DebugProxyCaptureStoreLike;
  asyncLease?: ReturnType<typeof createDebugProxyCaptureStoreForContext>;
  asyncStore?: AsyncDebugProxyCaptureStore;
  state: CaptureStateContext;
  usedAsync: boolean;
  writes: Set<Promise<unknown>>;
  finishing?: Promise<void>;
  closing?: Promise<void>;
  active: boolean;
  pending: Set<() => void>;
  errors: unknown[];
  unregister: () => void;
  admission: CaptureAdmission;
};
type CaptureAdmission = { current?: CaptureOwner };
type CaptureSession = {
  settings: DebugProxySettings;
  runtime: ReturnType<typeof resolveRuntimeDeps>;
  state: CaptureStateContext;
  errors: unknown[];
  claims: Map<OpenClawDatabaseMaintenanceScope | undefined, CaptureOwner>;
  admission: { current?: CaptureSession };
  closing: boolean;
  usedAsync: boolean;
  finishing?: Promise<void>;
  writes: Promise<void>;
};
type CaptureRegistry = {
  owners: Map<string, CaptureSession>;
  resolved: WeakMap<DebugProxySettings, CaptureSession["admission"]>;
  ambient?: { sessionId: string; dbPath: string; admission: CaptureSession["admission"] };
};
const captureOwners = new WeakMap<
  ReturnType<typeof resolveRuntimeDeps>["getStore"],
  CaptureRegistry
>();

type GlobalFetchPatchedState = {
  originalFetch: typeof globalThis.fetch;
  admission: CaptureSession["admission"];
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
  admission: CaptureSession["admission"],
): boolean {
  return fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]?.admission === admission;
}

/** Keep wrapper identity and its admission together for matching-owner teardown. */
export function registerDebugProxyFetchPatch(
  fetchTarget: GlobalFetchPatchTarget,
  originalFetch: typeof globalThis.fetch,
  patchedFetch: typeof globalThis.fetch,
  admission: CaptureSession["admission"],
): void {
  const patch = { originalFetch, admission };
  fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY] = patch;
  globalFetchPatches.set(patchedFetch, patch);
  fetchTarget.fetch = patchedFetch;
}

export function uninstallDebugProxyGlobalFetchPatch(
  deps: DebugProxyCaptureRuntimeDeps = {},
  admission?: CaptureSession["admission"],
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

export function reportCapturePersistenceFailure(
  owner: Pick<CaptureOwner, "errors">,
  error: unknown,
): void {
  owner.errors.push(error);
  reportCaptureError(error);
}

function reportCaptureError(error: unknown): void {
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
  if (owner.usedAsync) {
    throw new Error("Capture has asynchronous work; use finalizeDebugProxyCaptureAsync().");
  }
  sealCaptureOwner(owner);
  const lastClaim = releaseCaptureClaim(owner);
  try {
    if (lastClaim && !owner.store.isClosed) {
      owner.store.endSession(owner.settings.sessionId);
    }
  } catch (error) {
    reportCapturePersistenceFailure(owner, error);
  }
  forgetCaptureOwner(owner);
  if (owner.errors.length) {
    throw new AggregateError(owner.errors.splice(0), "Capture session finalization failed.");
  }
}

export function resolveCaptureOwner(
  settings: DebugProxySettings,
  runtime: ReturnType<typeof resolveRuntimeDeps>,
  options: { initialize?: boolean; explicit?: boolean; asynchronous?: boolean } = {},
): CaptureOwner | undefined {
  let registry = captureOwners.get(runtime.getStore);
  const key = captureOwnerKey(settings);
  let session = registry?.owners.get(key);
  if (!session) {
    // Explicit settings own their lifetime; ambient capture observes current
    // configuration. Keep only its current marker, not retired IDs or stores.
    const prior = options.explicit
      ? registry?.resolved.get(settings)
      : registry?.ambient?.sessionId === settings.sessionId &&
          registry.ambient.dbPath === settings.dbPath
        ? registry.ambient.admission
        : undefined;
    if (!options.initialize && prior) {
      session = prior.current;
      if (!session) {
        return undefined;
      }
    }
  }
  if (session?.closing) {
    return undefined;
  }
  const maintenanceScope = getOpenClawDatabaseMaintenanceScope();
  maintenanceScope?.assertAdmission();
  if (!registry) {
    registry = { owners: new Map(), resolved: new WeakMap() };
    captureOwners.set(runtime.getStore, registry);
  }
  if (!session) {
    session = {
      settings: { ...settings },
      runtime,
      state: captureStateContext(),
      errors: [],
      claims: new Map(),
      admission: {},
      closing: false,
      usedAsync: false,
      writes: Promise.resolve(),
    };
    session.admission.current = session;
  }
  let owner = session.claims.get(maintenanceScope);
  if (!owner) {
    const unregister: Array<() => void> = [];
    // The session retains its route; each new claim captures only its caller's
    // lexical maintenance authority, without rebinding any existing lease.
    const state: CaptureStateContext =
      "context" in session.state
        ? { context: { ...session.state.context, maintenanceScope } }
        : session.state;
    const getStore = () => {
      if (session.runtime.getStore !== getDebugProxyCaptureStore) {
        return session.runtime.getStore();
      }
      if ("error" in state) {
        throw state.error;
      }
      state.context.admission.assertCurrent();
      return getDebugProxyCaptureStore({ env: state.context.environment });
    };
    const store = options.asynchronous ? undefined : getStore();
    if (store?.isClosed) {
      return undefined;
    }
    owner = {
      session,
      maintenanceScope,
      settings: session.settings,
      runtime: session.runtime,
      syncStore: store,
      get store() {
        if (!this.syncStore) {
          if (this.asyncStore?.isClosed) {
            throw new Error("Capture store is closed.");
          }
          this.syncStore = getStore();
          unregister.push(
            registerCaptureStoreFinalizer(this.syncStore, () => finishCaptureOwner(this)),
          );
        }
        return this.syncStore;
      },
      state,
      usedAsync: false,
      writes: new Set(),
      active: true,
      pending: new Set(),
      errors: [],
      unregister: () => {
        for (const remove of unregister.splice(0)) {
          remove();
        }
      },
      admission: {},
    };
    owner.admission.current = owner;
    const retainedOwner = owner;
    if (store) {
      unregister.push(
        registerCaptureStoreFinalizer(store, () => finishCaptureOwner(retainedOwner)),
      );
    }
    unregister.push(registerActiveDebugProxyCapture(() => closeCaptureOwnerAsync(retainedOwner)));
    session.claims.set(maintenanceScope, owner);
    registry.owners.set(key, session);
    maintenanceScope?.own(retainedOwner, "shared-resources", () =>
      closeCaptureOwnerAsync(retainedOwner),
    );
  }
  if (!owner.active) {
    return undefined;
  }
  if (options.asynchronous) {
    owner.usedAsync = true;
    session.usedAsync = true;
  }
  if (options.explicit) {
    registry.resolved.set(settings, session.admission);
  } else {
    registry.ambient = {
      sessionId: settings.sessionId,
      dbPath: settings.dbPath,
      admission: session.admission,
    };
  }
  return owner;
}

/** A session-wide fetch patch admits the original caller before awaiting transport. */
export function resolveSessionCaptureOwner(
  admission: CaptureSession["admission"],
): CaptureOwner | undefined {
  const session = admission.current;
  if (!session || session.closing) {
    return undefined;
  }
  const owner = resolveCaptureOwnerForTransport(session.settings, session.runtime, {
    explicit: true,
    asynchronous: session.usedAsync,
  });
  if (owner && session.usedAsync && !owner.asyncLease) {
    // Reserve the admitted claim's terminal capability before transport can
    // outlive another claim. Readiness must not delay the original fetch.
    void observeCaptureWrite(
      owner,
      getAsyncCaptureStore(owner).then(() => undefined),
    );
  }
  return owner;
}

export function resolveCaptureOwnerForTransport(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
  options: { explicit?: boolean; asynchronous?: boolean } = {},
): CaptureOwner | undefined {
  let settings: DebugProxySettings | undefined;
  let runtime: ReturnType<typeof resolveRuntimeDeps> | undefined;
  try {
    settings = resolveEnabledDebugProxySettings(resolved);
    if (!settings) {
      return undefined;
    }
    runtime = resolveRuntimeDeps(deps);
    return resolveCaptureOwner(settings, runtime, {
      explicit: resolved !== undefined,
      ...options,
    });
  } catch (error) {
    const session =
      settings && runtime
        ? captureOwners.get(runtime.getStore)?.owners.get(captureOwnerKey(settings))
        : undefined;
    if (session) {
      reportCapturePersistenceFailure(session, error);
    } else {
      // A refusal before admission has no capture claim or store to finalize.
      reportCaptureError(error);
    }
    return undefined;
  }
}

// Finalization closes the session and restores the fetch patch before closing
// the cached store, preventing later normal requests from being captured.
/** @deprecated Use finalizeDebugProxyCaptureAsync to drain asynchronous capture work. */
export function finalizeDebugProxyCapture(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  const session = captureOwners.get(runtime.getStore)?.owners.get(captureOwnerKey(settings));
  const owners = [...(session?.claims.values() ?? [])];
  if (owners.some((owner) => owner.usedAsync)) {
    throw new Error("Capture has asynchronous work; use finalizeDebugProxyCaptureAsync().");
  }
  if (!session) {
    return;
  }
  session.closing = true;
  uninstallDebugProxyGlobalFetchPatch(session.runtime, session.admission);
  const errors: unknown[] = [];
  for (const owner of owners) {
    try {
      finishCaptureOwner(owner);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    if (runtime.closeStore) {
      runtime.closeStore();
    } else {
      for (const store of new Set(owners.map((owner) => owner.syncStore))) {
        store?.close?.();
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "Capture finalization failed.");
  }
}

function sealCaptureOwner(owner: CaptureOwner): void {
  revokeCaptureOwner(owner);
  for (const finish of owner.pending) {
    finish();
  }
}

function revokeCaptureOwner(owner: CaptureOwner): void {
  owner.active = false;
  owner.admission.current = undefined;
}

function forgetCaptureOwner(owner: CaptureOwner): void {
  const registry = captureOwners.get(owner.runtime.getStore);
  if (
    owner.session.claims.size === 0 &&
    registry?.owners.get(captureOwnerKey(owner.settings)) === owner.session
  ) {
    registry.owners.delete(captureOwnerKey(owner.settings));
  }
  owner.unregister();
}

function releaseCaptureClaim(owner: CaptureOwner): boolean {
  const session = owner.session;
  if (session.claims.get(owner.maintenanceScope) !== owner) {
    return false;
  }
  session.claims.delete(owner.maintenanceScope);
  if (session.claims.size > 0) {
    return false;
  }
  session.closing = true;
  session.admission.current = undefined;
  owner.errors.push(...session.errors.splice(0));
  uninstallDebugProxyGlobalFetchPatch(session.runtime, session.admission);
  return true;
}

/** Observe callback-owned work without converting its rejection into success. */
export function observeCaptureWrite<T>(owner: CaptureOwner, operation: Promise<T>): Promise<T> {
  owner.usedAsync = true;
  owner.writes.add(operation);
  void operation.then(
    () => owner.writes.delete(operation),
    (error: unknown) => {
      owner.writes.delete(operation);
      reportCapturePersistenceFailure(owner, error);
    },
  );
  return operation;
}

function ensureAsyncCaptureLease(owner: CaptureOwner) {
  owner.usedAsync = true;
  const context = currentStateContext(owner);
  if (!owner.asyncLease) {
    const lease = createDebugProxyCaptureStoreForContext(context);
    owner.asyncLease = lease;
    owner.asyncStore = lease.store;
    const unregister = registerAsyncCaptureStoreFinalizer(lease.store, (finalizingStore) => {
      owner.asyncStore = finalizingStore;
      const finishing = finishCaptureOwnerAsync(owner);
      // Observe the memoized owning close without awaiting it from its finalizer.
      void lease.store.close().then(
        () => {
          if (!owner.closing) {
            forgetCaptureOwner(owner);
          }
        },
        () => {
          if (!owner.closing) {
            forgetCaptureOwner(owner);
          }
        },
      );
      return finishing;
    });
    const previous = owner.unregister;
    owner.unregister = () => {
      unregister();
      previous();
    };
  }
  return owner.asyncLease;
}

export async function getAsyncCaptureStore(
  owner: CaptureOwner,
): Promise<AsyncDebugProxyCaptureStore> {
  const lease = ensureAsyncCaptureLease(owner);
  await lease.ready;
  return lease.store;
}

export function runCaptureOperation<T>(
  owner: CaptureOwner,
  operation: (store: AsyncDebugProxyCaptureStore) => Promise<T>,
): Promise<T> {
  return ensureAsyncCaptureLease(owner).runOperation(operation);
}

/** Reserve retained input before copying facts or waiting for FIFO admission. */
export async function recordCaptureEventAsync(
  owner: CaptureOwner,
  event: CaptureEventRecord,
  payload: CapturePayloadInput | undefined,
  store: AsyncDebugProxyCaptureStore,
): Promise<void> {
  const data = payload?.data;
  const inputBytes =
    serialize(
      payload === undefined
        ? { type: "capture.recordEvent", input: event }
        : {
            type: "capture.recordEventWithPayload",
            input: {
              event,
              payload: { ...payload, data: Buffer.isBuffer(data) ? Buffer.alloc(0) : data },
            },
          },
    ).byteLength + (Buffer.isBuffer(data) ? data.byteLength : 0);
  const preparation = reserveSqliteWorkerInputPreparation(inputBytes);
  try {
    const preparedEvent = { ...event };
    const preparedPayload =
      payload === undefined
        ? undefined
        : { ...payload, data: Buffer.isBuffer(data) ? Buffer.from(data) : data };
    const ready = ensureAsyncCaptureLease(owner).ready;
    return await sequenceCaptureWrite(owner, store, async (execution) => {
      await ready;
      return preparation.handoff(() =>
        preparedPayload === undefined
          ? execution.recordEvent(preparedEvent)
          : execution.recordEventWithPayload(preparedEvent, preparedPayload),
      );
    });
  } finally {
    preparation.release();
  }
}

export function sequenceCaptureWrite<T>(
  owner: CaptureOwner,
  store: AsyncDebugProxyCaptureStore,
  write: (store: AsyncDebugProxyCaptureStore) => Promise<T>,
): Promise<T> {
  // The invocation's private capability survives its body read or cold lease
  // wait. Only finite commands enter maintenance's pending-operation drain.
  const operation = owner.session.writes.then(() => write(store));
  owner.session.writes = operation.then(
    () => undefined,
    () => undefined,
  );
  return owner.maintenanceScope ? owner.maintenanceScope.track(operation) : operation;
}

function finishCaptureOwnerAsync(owner: CaptureOwner): Promise<void> {
  if (owner.finishing) {
    return owner.finishing;
  }
  const completion = createDeferredCore();
  owner.finishing = completion.promise;
  sealCaptureOwner(owner);
  const finish = async () => {
    while (owner.writes.size) {
      await Promise.allSettled(owner.writes);
    }
    try {
      const lastClaim = releaseCaptureClaim(owner);
      if (lastClaim && owner.asyncLease) {
        const lease = owner.asyncLease;
        await lease.ready;
        const store = owner.asyncStore ?? lease.store;
        if (store.isClosed) {
          throw new SqliteWorkerError("Capture store is closed", "closed");
        }
        await store.endSession(owner.settings.sessionId);
      } else if (lastClaim && owner.syncStore && !owner.syncStore.isClosed) {
        owner.syncStore.endSession(owner.settings.sessionId);
      }
    } catch (error) {
      reportCapturePersistenceFailure(owner, error);
    }
    if (owner.errors.length) {
      throw new AggregateError(owner.errors.splice(0), "Capture session finalization failed.");
    }
  };
  void finish().then(completion.resolve, completion.reject);
  void completion.promise.catch(() => undefined);
  return completion.promise;
}

function closeCaptureOwnerAsync(owner: CaptureOwner): Promise<void> {
  if (owner.closing) {
    return owner.closing;
  }
  const completion = createDeferredCore();
  owner.closing = completion.promise;
  revokeCaptureOwner(owner);
  const close = async () => {
    const errors: unknown[] = [];
    try {
      if (owner.asyncLease) {
        await owner.asyncLease.release();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      // Retiring a lease skips its store finalizer. The capture owner still
      // settles accepted callbacks and reports diagnostics without reopening it.
      await finishCaptureOwnerAsync(owner);
    } catch (error) {
      if (!errors.some((previous) => collectNestedErrorCandidates(previous).includes(error))) {
        errors.push(error);
      }
    }
    try {
      if (owner.session.claims.size === 0 && owner.runtime.closeStore) {
        owner.runtime.closeStore();
      } else if (owner.session.claims.size === 0) {
        owner.syncStore?.close?.();
      }
    } catch (error) {
      errors.push(error);
    }
    forgetCaptureOwner(owner);
    if (errors.length) {
      throw new AggregateError(errors, "Capture finalization failed.");
    }
  };
  void close().then(completion.resolve, completion.reject);
  void completion.promise.catch(() => undefined);
  return completion.promise;
}

export function finalizeDebugProxyCaptureAsync(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): Promise<void> {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return Promise.resolve();
  }
  const runtime = resolveRuntimeDeps(deps);
  const session = captureOwners.get(runtime.getStore)?.owners.get(captureOwnerKey(settings));
  if (!session) {
    return Promise.resolve();
  }
  if (session.finishing) {
    return session.finishing;
  }
  session.closing = true;
  uninstallDebugProxyGlobalFetchPatch(session.runtime, session.admission);
  const owners = [...session.claims.values()];
  if (owners.length === 1) {
    return (session.finishing = closeCaptureOwnerAsync(owners[0]!));
  }
  return (session.finishing = Promise.allSettled(owners.map(closeCaptureOwnerAsync)).then(
    (results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Capture finalization failed.");
      }
    },
  ));
}
