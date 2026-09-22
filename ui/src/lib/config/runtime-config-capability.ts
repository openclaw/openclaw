import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { showToast } from "../toast.ts";
import { createAppliedConfigRefreshController } from "./applied-refresh.ts";
import { clearConfigDraftTracking } from "./config-draft-model.ts";
import {
  loadConfig,
  loadConfigSchema,
  lookupConfigSchemaPath,
  openConfigFile,
  type ConfigPatchBuilder,
  type ConfigWriteCoordinator,
  type ConfigMethod,
  type ConfigPatchOptions,
  type RuntimeConfigDispatchOptions,
  type RuntimeConfigExternalMutationOptions,
  type RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
import {
  agentConfigEntry,
  clearConfigRequestVersions,
  createInitialConfigState,
  type AgentConfigEntryTarget,
  type RuntimeConfigGateway,
  type RuntimeConfigState,
} from "./config-state-model.ts";
import { createConfigWriteCoordinator } from "./config-write-coordinator.ts";

export type RuntimeConfigCapability = {
  readonly state: RuntimeConfigState;
  readonly canSet?: boolean;
  readonly canApply?: boolean;
  readonly canPatch?: boolean;
  readonly canOpenFile?: boolean;
  ensureLoaded: () => Promise<void>;
  ensureSchemaLoaded: () => Promise<void>;
  refresh: (options?: { background?: boolean }) => Promise<void>;
  refreshSchema: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  /** Reloads from disk; offline drafts reset locally unless reloadOnly is requested. */
  discardDraft: (options?: { reloadOnly?: boolean }) => Promise<void>;
  /** Reconciles one canceled field with saved config while preserving unrelated draft edits. */
  discardFormValue: (path: Array<string | number>) => Promise<boolean>;
  /** Pauses/resumes all config writes (autosave + manual) while e.g. the app updater runs. */
  setWritesSuspended: (suspended: boolean, refreshAdmission?: () => Promise<void>) => void;
  /** Resolves once no config write is in flight (used as an updater barrier). */
  waitForPendingWrites: () => Promise<void>;
  /** Commits queued form edits without overriding autosave recovery or reconnect policy. */
  flushFormChanges: () => Promise<boolean>;
  save: (options?: RuntimeConfigDispatchOptions) => Promise<boolean>;
  retry: () => Promise<boolean>;
  apply: () => Promise<boolean>;
  openFile: () => Promise<void>;
  /** Resolves the authored keyed entry; ensure returns a writable target without mutating. */
  agentEntry: (agentId: string, options?: { ensure?: boolean }) => AgentConfigEntryTarget | null;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  patchFromSnapshot: (build: ConfigPatchBuilder) => Promise<boolean>;
  /**
   * Serializes a config-writing RPC behind this capability's pending draft,
   * then refreshes the authoritative snapshot before resolving.
   */
  runExternalMutation: <T>(
    task: (client: GatewayBrowserClient) => Promise<T>,
    options?: RuntimeConfigExternalMutationOptions<T>,
  ) => Promise<RuntimeConfigExternalMutationResult<T>>;
  lookupSchemaPath: (path: string) => Promise<unknown>;
  subscribe: (listener: (state: RuntimeConfigState) => void) => () => void;
  dispose: () => void;
};

export function createRuntimeConfigCapability(
  gateway: RuntimeConfigGateway,
): RuntimeConfigCapability {
  const state = createInitialConfigState(gateway.snapshot);
  // Raw edits never autosave; form edits and outstanding writes also remain
  // owned by this capability when a worker update or reconnect wants to reload.
  const stopReloadGuard = registerControlUiReloadGuard(
    () => !state.configFormDirty && !state.configSaving && !state.configApplying,
    () => showToast({ message: t("configView.reloadBlocked") }),
  );
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  const loads = new Map<"config" | "schema", Promise<unknown>>();
  let disposed = false;

  const canCallConfigMethod = (
    method: ConfigMethod,
    options?: { requireAdvertisement?: boolean },
  ) =>
    canCallGatewayMethod(
      {
        client: gateway.snapshot.client,
        hello: gateway.snapshot.hello ?? null,
        phase: gateway.snapshot.phase,
      },
      method,
      method === "config.schema" ? "operator.read" : "operator.admin",
      options,
    );
  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async <T>(task: () => Promise<T>, loadKey?: "config" | "schema"): Promise<T> => {
    let result: Promise<T> | undefined;
    try {
      result = task();
      // Subscribers can ensure missing config even when a load is offline or background.
      if (loadKey) {
        loads.set(loadKey, result);
      }
      // Async config owners mutate their busy flag before the first await.
      // Publish that transition so editors can lock before accepting more input.
      publish();
      return await result;
    } finally {
      try {
        publish();
      } finally {
        if (loadKey && loads.get(loadKey) === result) {
          loads.delete(loadKey);
        }
      }
    }
  };
  const mutate = (task: () => void) => {
    task();
    publish();
  };
  const loadOnce = async (
    key: "config" | "schema",
    task: () => Promise<unknown>,
  ): Promise<void> => {
    await (loads.get(key) ?? run(task, key));
  };

  const appliedRefresh = createAppliedConfigRefreshController({
    shouldRefresh: () =>
      !disposed &&
      state.connected &&
      state.configNeedsApply &&
      state.configSnapshot?.appliedConfigHash !== undefined,
    refresh: (isCurrent) =>
      loadOnce("config", () => loadConfig(state, { background: true }, isCurrent)),
  });
  const refreshConnectionState = (beforeApplySnapshot?: () => void) => {
    const config = run(() => loadConfig(state, { beforeApplySnapshot }), "config");
    if (state.configSchemaVersion !== null && canLoadConfigSchema()) {
      void run(() => loadConfigSchema(state), "schema");
    }
    return config;
  };

  const writes: ConfigWriteCoordinator = createConfigWriteCoordinator({
    state,
    gateway,
    publish,
    run,
    mutate,
    resetLoads: () => {
      loads.clear();
    },
    resetConfigLoad: () => {
      loads.delete("config");
    },
    refreshConnectionState,
    canCallConfigMethod,
    cancelAppliedRefresh: appliedRefresh.cancel,
    reconcileAppliedRefresh: appliedRefresh.reconcile,
    disposeAppliedRefresh: appliedRefresh.dispose,
    isDisposed: () => disposed,
  });

  const ensureLoaded = async () => {
    if (!state.configSnapshot) {
      await loadOnce("config", () => loadConfig(state));
    }
    appliedRefresh.reconcile();
  };
  // Schema reads fail open like operator-access: only a definitive denial
  // (method advertised absent, or advertised scopes without read) skips the
  // load, so legacy scope-less gateways keep schema-driven settings pages.
  const canLoadConfigSchema = () => {
    const snapshot = gateway.snapshot;
    if (!snapshot.client || snapshot.phase !== "connected") {
      return false;
    }
    if (isGatewayMethodAdvertised(snapshot, "config.schema") === false) {
      return false;
    }
    return hasOperatorReadAccess(snapshot.hello?.auth ?? null);
  };
  const ensureSchemaLoaded = () =>
    state.configSchema || !canLoadConfigSchema()
      ? Promise.resolve()
      : loadOnce("schema", () => loadConfigSchema(state));

  return {
    get state() {
      return state;
    },
    get canSet() {
      return canCallConfigMethod("config.set");
    },
    get canApply() {
      return canCallConfigMethod("config.apply");
    },
    get canPatch() {
      return canCallConfigMethod("config.patch");
    },
    get canOpenFile() {
      return canCallConfigMethod("config.openFile", { requireAdvertisement: false });
    },
    ensureLoaded,
    ensureSchemaLoaded,
    refresh: async (options) => {
      appliedRefresh.cancel();
      try {
        await run(() => loadConfig(state, options), "config");
      } finally {
        appliedRefresh.reconcile();
      }
    },
    refreshSchema: () => run(() => loadConfigSchema(state), "schema"),
    patchForm: writes.patchForm,
    removeFormValue: writes.removeFormValue,
    setRaw: writes.setRaw,
    discardDraft: writes.discardDraft,
    discardFormValue: writes.discardFormValue,
    setWritesSuspended: writes.setWritesSuspended,
    waitForPendingWrites: writes.waitForPendingWrites,
    flushFormChanges: writes.flushFormChanges,
    save: writes.save,
    retry: writes.retry,
    apply: writes.apply,
    openFile: () =>
      canCallConfigMethod("config.openFile", { requireAdvertisement: false })
        ? run(() => openConfigFile(state))
        : Promise.resolve(),
    agentEntry: (agentId, options) => agentConfigEntry(state, agentId, options),
    stageDefaultAgent: writes.stageDefaultAgent,
    patch: writes.patch,
    patchFromSnapshot: writes.patchFromSnapshot,
    runExternalMutation: writes.runExternalMutation,
    lookupSchemaPath: (path) => run(() => lookupConfigSchemaPath(state, path)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopReloadGuard();
      disposed = true;
      writes.dispose();
      listeners.clear();
      clearConfigRequestVersions(state);
      clearConfigDraftTracking(state);
    },
  };
}
