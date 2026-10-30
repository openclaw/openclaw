import type { Result } from "@openclaw/normalization-core/result";
import { registerListener } from "../../../../src/shared/listeners.js";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../toast.ts";
import { createAppliedConfigRefreshOwner } from "./applied-refresh.ts";
import { applyConfigSnapshot, clearConfigDraftTracking } from "./config-draft-model.ts";
import {
  loadConfig,
  loadConfigSchema,
  lookupConfigSchemaPath,
  openConfigFile,
  type ConfigWriteCoordinator,
  type ConfigMethod,
} from "./config-gateway-operations.ts";
import { canEnsureConfigRead } from "./config-gateway-read.ts";
import {
  agentConfigEntry,
  clearConfigRequestVersions,
  type createInitialConfigState,
  currentConfigConnectionEpoch,
  type RuntimeConfigGateway,
  type RuntimeConfigState,
} from "./config-state-model.ts";
import { createConfigWriteCoordinator } from "./config-write-coordinator.ts";

export function createRuntimeConfigEditor(
  state: ReturnType<typeof createInitialConfigState>,
  gateway: RuntimeConfigGateway,
  canCallConfigMethod: (
    method: ConfigMethod,
    options?: { requireAdvertisement?: boolean },
  ) => boolean,
  bootstrap?: {
    current: () => Record<string, unknown> | null;
    subscribe: (listener: () => void) => () => void;
  },
  initialRead?: Promise<unknown>,
) {
  // A read-only boot snapshot becomes an editable base with its original hash/raw pair.
  if (state.configSnapshot) {
    applyConfigSnapshot(state, state.configSnapshot);
  }
  // Raw edits never autosave; form edits and outstanding writes also remain
  // owned by this capability when a worker update or reconnect wants to reload.
  const stopReloadGuard = registerControlUiReloadGuard(
    () =>
      !state.configFormDirty &&
      !state.configSaving &&
      !state.configApplying &&
      !writes.hasUnacknowledgedDraftWrite(),
    () => showToast({ message: t("configView.reloadBlocked") }),
  );
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  const loads = new Map<"config" | "schema", Promise<unknown>>();
  let schemaRead: Promise<Result<void, string>> | null = null;
  let disposed = false;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  // Bootstrap changes update the capability's fallback config before views read it.
  const stopBootstrap = bootstrap?.subscribe(publish);
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
  const loadConfigOnce = (task: () => Promise<unknown>) =>
    loads.get("config") ?? run(task, "config");
  // The display reader keeps its request; editing takes custody without waiting
  // to expose independent schema reads or an explicit replacement refresh.
  if (initialRead) {
    void run(() => initialRead, "config");
  }

  const loadSchema = () => {
    if (loads.has("schema") && schemaRead) {
      return schemaRead;
    }
    // Retain the admitted completion, including failure, until retry or reconnect.
    return run(() => (schemaRead = loadConfigSchema(state)), "schema");
  };

  const appliedRefresh = createAppliedConfigRefreshOwner({
    shouldRefresh: () =>
      !disposed &&
      state.connected &&
      state.configNeedsApply &&
      state.configSnapshot?.appliedConfigHash !== undefined,
    refresh: (isCurrent) =>
      loadConfigOnce(() => loadConfig(state, { background: true, draftWrites: writes }, isCurrent)),
  });
  const refreshConnectionState = (
    beforeApplySnapshot?: () => void,
    preservePendingChanges = false,
  ) => {
    const epoch = currentConfigConnectionEpoch(state);
    const pendingSchema = loads.get("schema");
    const config = run(
      () =>
        loadConfig(state, {
          beforeApplySnapshot,
          preservePendingChanges,
          draftWrites: writes,
        }),
      "config",
    );
    if ((state.configSchemaVersion !== null || pendingSchema) && canLoadConfigSchema()) {
      // Config success clears lastError; load the schema afterward to preserve its failures.
      void config.then(async () => {
        // A plugin change during a schema read needs one catch-up after that read.
        await pendingSchema;
        if (currentConfigConnectionEpoch(state) === epoch) {
          await loadSchema();
        }
      });
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
      schemaRead = null;
    },
    resetConfigLoad: () => {
      loads.delete("config");
    },
    refreshConnectionState,
    canCallConfigMethod,
    appliedRefresh,
    isDisposed: () => disposed,
  });

  // Schema reads use the same read-access policy as the settings pages.
  const canLoadConfigSchema = () => {
    const snapshot = gateway.snapshot;
    if (!snapshot.client || snapshot.phase !== "connected") {
      return false;
    }
    return hasOperatorReadAccess(snapshot.hello?.auth ?? null);
  };
  return {
    snapshotOwner: writes,
    get state() {
      return state;
    },
    get schemaRead() {
      return schemaRead;
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
    ensureLoaded: async () => {
      // A held load joins; a read that cannot start or just failed must not publish again.
      if (!state.configSnapshot && (loads.has("config") || canEnsureConfigRead(state))) {
        await loadConfigOnce(() => loadConfig(state, { draftWrites: writes }));
      }
      appliedRefresh.reconcile();
    },
    ensureSchemaLoaded: async () => {
      if (!state.configSchema && canLoadConfigSchema()) {
        await loadSchema();
      }
    },
    refresh: async (options?: { background?: boolean }) => {
      appliedRefresh.cancel();
      try {
        await run(() => loadConfig(state, { ...options, draftWrites: writes }), "config");
      } finally {
        appliedRefresh.reconcile();
      }
    },
    refreshSchema: loadSchema,
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
    agentEntry: (agentId: string, options?: { ensure?: boolean }) =>
      agentConfigEntry(state, agentId, options),
    stageDefaultAgent: writes.stageDefaultAgent,
    patch: writes.patch,
    patchFromSnapshot: writes.patchFromSnapshot,
    runExternalMutation: writes.runExternalMutation,
    lookupSchemaPath: (path: string) => run(() => lookupConfigSchemaPath(state, path)),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      return registerListener(listeners, listener);
    },
    dispose() {
      stopBootstrap?.();
      stopReloadGuard();
      disposed = true;
      writes.dispose();
      listeners.clear();
      clearConfigRequestVersions(state);
      clearConfigDraftTracking(state);
    },
  };
}

export type RuntimeConfigEditor = ReturnType<typeof createRuntimeConfigEditor>;
