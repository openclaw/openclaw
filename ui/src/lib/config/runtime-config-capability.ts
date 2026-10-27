import type { Result } from "@openclaw/normalization-core/result";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import { createAppliedConfigRefreshOwner } from "./applied-refresh.ts";
import type { ConfigMethod } from "./config-gateway-operations.ts";
import { canEnsureConfigRead, loadConfigSnapshot } from "./config-gateway-read.ts";
import {
  agentConfigEntry,
  clearConfigRequestVersions,
  createInitialConfigState,
  currentConfigConnectionEpoch,
  currentConfigRead,
  invalidateConfigConnection,
  setConfigSnapshot,
  type RuntimeConfigGateway,
  type RuntimeConfigState,
} from "./config-state-model.ts";
import type { RuntimeConfigEditor } from "./runtime-config-editor.ts";

type OptionalRuntimeConfigCapabilityKey = "canSet" | "canApply" | "canPatch" | "canOpenFile";
export type RuntimeConfigCapability = Omit<
  RuntimeConfigEditor,
  OptionalRuntimeConfigCapabilityKey | "snapshotOwner"
> &
  Partial<Pick<RuntimeConfigEditor, OptionalRuntimeConfigCapabilityKey>> & {
    ensureDisplayLoaded: () => Promise<void>;
    refreshDisplay: (options?: { background?: boolean }) => Promise<void>;
  };

/** Bootstrap display facts stay eager; editing is activated by the first config operation. */
export function createRuntimeConfigCapability(
  gateway: RuntimeConfigGateway,
  bootstrap?: {
    current: () => Record<string, unknown> | null;
    subscribe: (listener: () => void) => () => void;
  },
): RuntimeConfigCapability {
  const state = createInitialConfigState(gateway.snapshot, bootstrap?.current);
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  let editor: RuntimeConfigEditor | null = null;
  let activation: Promise<RuntimeConfigEditor | null> | null = null;
  let disposed = false;
  let pendingSchema: Promise<Result<void, string>> | null = null;
  let suspension: Parameters<RuntimeConfigEditor["setWritesSuspended"]> = [false];
  let stopEditor: (() => void) | undefined;
  let updateEditorConnection: ((snapshot: RuntimeConfigGateway["snapshot"]) => void) | undefined;
  let displayRead: Promise<boolean> | null = null;
  const publish = () => {
    if (!disposed) {
      for (const listener of listeners) {
        listener(state);
      }
    }
  };
  const displaySnapshotOwner = {
    hasUnacknowledgedDraftWrite: () => editor?.snapshotOwner.hasUnacknowledgedDraftWrite() ?? false,
    applySnapshot: (snapshot: ConfigSnapshot) => {
      if (editor) {
        editor.snapshotOwner.applySnapshot(snapshot);
        return;
      }
      setConfigSnapshot(state, snapshot);
      if (snapshot.appliedConfigHash !== undefined) {
        const revision = snapshot.configRevisionHash ?? snapshot.hash ?? null;
        state.configNeedsApply = revision !== snapshot.appliedConfigHash;
      }
    },
  };
  const displayRefresh = createAppliedConfigRefreshOwner({
    shouldRefresh: () =>
      !disposed &&
      !activation &&
      !editor &&
      state.connected &&
      state.configNeedsApply &&
      state.configSnapshot?.appliedConfigHash !== undefined,
    refresh: (isCurrent) => displayRead ?? runDisplayRead({ background: true }, isCurrent),
  });
  async function runDisplayRead(
    options: { background?: boolean } = {},
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    const result = loadConfigSnapshot(
      state,
      { ...options, snapshotOwner: displaySnapshotOwner },
      isCurrent,
    );
    // Claim the read before observers can ask for the missing snapshot again.
    displayRead = result;
    try {
      publish();
      return await result;
    } finally {
      try {
        publish();
      } finally {
        if (displayRead === result) {
          displayRead = null;
        }
      }
    }
  }
  async function ensureDisplayLoaded(): Promise<void> {
    if (editor) {
      return editor.ensureLoaded();
    }
    if (!state.configSnapshot && (displayRead || canEnsureConfigRead(state))) {
      await (displayRead ?? runDisplayRead());
    }
    displayRefresh.reconcile();
  }
  async function refreshDisplay(options?: { background?: boolean }): Promise<void> {
    if (editor) {
      return editor.refresh(options);
    }
    displayRefresh.cancel();
    try {
      await runDisplayRead(options);
    } finally {
      displayRefresh.reconcile();
    }
  }
  const stopBootstrap = bootstrap?.subscribe(publish);
  let canRead = hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null);
  let pluginGeneration = gateway.snapshot.pluginCapabilities?.generation;
  // The same state holds display snapshots before the editor takes custody.
  const stopGateway = gateway.subscribe((snapshot) => {
    if (updateEditorConnection) {
      updateEditorConnection(snapshot);
      return;
    }
    const nextCanRead = hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const hadDisplaySnapshot = state.configSnapshot !== null;
    const accessLost = snapshot.phase === "connected" && canRead && !nextCanRead;
    const connectionChanged =
      state.client !== snapshot.client ||
      state.connected !== (snapshot.phase === "connected") ||
      accessLost;
    const nextPluginGeneration = snapshot.pluginCapabilities?.generation;
    const pluginsChanged =
      nextPluginGeneration !== undefined && nextPluginGeneration !== pluginGeneration;
    pluginGeneration = nextPluginGeneration;
    if (connectionChanged) {
      invalidateConfigConnection(state);
      // There is no draft yet; do not promote an old connection's display data to an editor base.
      state.configSnapshot = null;
      displayRead = null;
      displayRefresh.cancel();
      pendingSchema = null;
      state.configLoading = false;
      state.configSchemaLoading = false;
    }
    if (snapshot.phase === "connected") {
      canRead = nextCanRead;
    }
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    state.applySessionKey = snapshot.sessionKey;
    if (
      state.connected &&
      state.client &&
      !accessLost &&
      ((connectionChanged && (hadDisplaySnapshot || !state.bootstrapConfig)) ||
        (pluginsChanged && state.configSnapshot))
    ) {
      void refreshDisplay();
    }
    publish();
  });
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
  const activate = (): Promise<RuntimeConfigEditor | null> => {
    if (editor || disposed) {
      return Promise.resolve(editor);
    }
    if (!activation) {
      displayRefresh.cancel();
      activation = import("./runtime-config-editor.ts")
        .then(({ createRuntimeConfigEditor }) => {
          if (disposed) {
            return null;
          }
          stopBootstrap?.();
          displayRefresh.dispose();
          editor = createRuntimeConfigEditor(
            state,
            {
              get snapshot() {
                return gateway.snapshot;
              },
              subscribe(listener) {
                // Keep connection updates ahead of consumers registered after this capability.
                updateEditorConnection = listener;
                return () => {
                  updateEditorConnection = undefined;
                };
              },
            },
            canCallConfigMethod,
            bootstrap,
            displayRead ? currentConfigRead(state)?.settled : undefined,
          );
          // Hand schema admission to the editor before a load publication can reenter it.
          if (pendingSchema) {
            state.configSchemaLoading = false;
          }
          editor.setWritesSuspended(...suspension);
          stopEditor = editor.subscribe(publish);
          if (state.configSnapshot) {
            state.configLoading = false;
            void editor.ensureLoaded();
            publish();
          }
          return editor;
        })
        .catch((error: unknown) => {
          activation = null;
          pendingSchema = null;
          if (!disposed) {
            state.lastError = formatUiError(error);
            state.configLoading = false;
            state.configSchemaLoading = false;
            publish();
            displayRefresh.reconcile();
          }
          throw error;
        });
    }
    return activation;
  };
  const invoke = <T>(
    task: (loaded: RuntimeConfigEditor) => Promise<T>,
    unavailable: T,
  ): Promise<T> => {
    if (editor) {
      return task(editor);
    }
    const client = state.client;
    const epoch = currentConfigConnectionEpoch(state);
    return activate().then((loaded) =>
      loaded && state.client === client && currentConfigConnectionEpoch(state) === epoch
        ? task(loaded)
        : unavailable,
    );
  };
  const invokeWrite = (
    method: ConfigMethod,
    task: (loaded: RuntimeConfigEditor) => Promise<boolean>,
    canDispatch?: () => boolean,
  ) => {
    if (editor) {
      return task(editor);
    }
    if (!canCallConfigMethod(method)) {
      if (state.connected) {
        state.lastError = t("configView.adminRequired");
        publish();
      }
      return Promise.resolve(false);
    }
    return canDispatch?.() === false ? Promise.resolve(false) : invoke(task, false);
  };
  const read = (task: (loaded: RuntimeConfigEditor) => Promise<void>, background = false) => {
    if (editor) {
      return task(editor);
    }
    const result = invoke((loaded) => {
      // Hand the module-loading flag to the read before its coalesced publication.
      if (!currentConfigRead(state)) {
        state.configLoading = false;
      }
      return task(loaded);
    }, undefined);
    if (
      !background &&
      state.client &&
      state.connected &&
      canRead &&
      !disposed &&
      !state.configLoading
    ) {
      state.configLoading = true;
      publish();
    }
    return result;
  };
  const requireEditor = () => {
    if (!editor) {
      throw new Error("Load configuration before editing its draft.");
    }
    return editor;
  };
  const loadSchema = (refresh: boolean): Promise<Result<void, string>> => {
    if (editor) {
      const loaded = editor;
      if (refresh) {
        return loaded.refreshSchema();
      }
      const loading = loaded.ensureSchemaLoaded();
      // A reconnect can replace schemaRead before this caller's read settles.
      const receipt = loaded.schemaRead;
      return loading.then(() => receipt ?? { ok: true, value: undefined });
    }
    if (pendingSchema) {
      return pendingSchema;
    }
    pendingSchema = invoke<Result<void, string>>(
      async (loaded) => {
        if (refresh) {
          return loaded.refreshSchema();
        }
        const loading = loaded.ensureSchemaLoaded();
        const receipt = loaded.schemaRead;
        await loading;
        return receipt ?? { ok: true as const, value: undefined };
      },
      { ok: true as const, value: undefined },
    );
    if (state.client && state.connected && canRead && !disposed) {
      state.configSchemaLoading = true;
      publish();
    }
    return pendingSchema;
  };
  return {
    get state() {
      return state;
    },
    get schemaRead() {
      return editor ? editor.schemaRead : pendingSchema;
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
    ensureDisplayLoaded,
    refreshDisplay,
    ensureLoaded: () =>
      !editor && !state.configSnapshot && !displayRead && !canEnsureConfigRead(state)
        ? Promise.resolve()
        : read((loaded) => loaded.ensureLoaded()),
    ensureSchemaLoaded: () => loadSchema(false).then(() => undefined),
    refresh: (options) => read((loaded) => loaded.refresh(options), options?.background),
    refreshSchema: () => loadSchema(true),
    patchForm: (path, value) => requireEditor().patchForm(path, value),
    removeFormValue: (path) => requireEditor().removeFormValue(path),
    setRaw: (value) => requireEditor().setRaw(value),
    discardDraft: (options) => invoke((loaded) => loaded.discardDraft(options), undefined),
    discardFormValue: (path) => invoke((loaded) => loaded.discardFormValue(path), false),
    setWritesSuspended: (...args) => {
      if (editor) {
        editor.setWritesSuspended(...args);
      } else {
        suspension = args;
      }
    },
    waitForPendingWrites: () => editor?.waitForPendingWrites() ?? Promise.resolve(),
    flushFormChanges: () => editor?.flushFormChanges() ?? Promise.resolve(false),
    save: (options) =>
      invokeWrite("config.set", (loaded) => loaded.save(options), options?.canDispatch),
    retry: () => invoke((loaded) => loaded.retry(), false),
    apply: () => invokeWrite("config.apply", (loaded) => loaded.apply()),
    openFile: () =>
      canCallConfigMethod("config.openFile", { requireAdvertisement: false })
        ? invoke((loaded) => loaded.openFile(), undefined)
        : Promise.resolve(),
    agentEntry: (agentId, options) => agentConfigEntry(state, agentId, options),
    stageDefaultAgent: (agentId) => editor?.stageDefaultAgent(agentId) ?? false,
    patch: (options) =>
      invokeWrite("config.patch", (loaded) => loaded.patch(options), options.canDispatch),
    patchFromSnapshot: (build) =>
      invokeWrite("config.patch", (loaded) => loaded.patchFromSnapshot(build)),
    runExternalMutation: (task, options) =>
      invoke((loaded) => loaded.runExternalMutation(task, options), {
        ok: false,
        reason: "unavailable",
        error: "Connection changed before the configuration update started.",
      }),
    lookupSchemaPath: (path) => invoke((loaded) => loaded.lookupSchemaPath(path), null),
    subscribe: (listener) => registerListener(listeners, listener),
    dispose() {
      disposed = true;
      stopGateway();
      stopBootstrap?.();
      stopEditor?.();
      displayRefresh.dispose();
      if (editor) {
        editor.dispose();
      } else {
        invalidateConfigConnection(state);
        state.connected = false;
        state.configLoading = false;
        state.configSchemaLoading = false;
        clearConfigRequestVersions(state);
      }
      listeners.clear();
    },
  };
}
