import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  type TerminalOpenResult,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import { disposeTerminalController } from "./terminal-controller-lifecycle.ts";
import {
  adoptTerminalPanelSession,
  bootTerminalPanelSession,
  captureTerminalDeliveryError,
  createTerminalSessionBootOperations,
} from "./terminal-panel-session-boot.ts";
import { TerminalPanelSessionRecovery } from "./terminal-panel-session-recovery.ts";
import { focusTerminalSession } from "./terminal-panel-session-rendering.ts";
import type {
  TerminalOperation,
  TerminalPanelError,
  TerminalPanelSessionHost,
  TerminalPanelSessionState,
  TerminalPanelSessionTab,
  TerminalRestoreBatch,
  TerminalSessionListOptions,
  TerminalStagedInput,
} from "./terminal-panel-session-types.ts";
import { createTerminalIntentQueue, terminalIntentQueue } from "./terminal-pending-actions.ts";
import type { TerminalIntentHost } from "./terminal-pending-actions.ts";
import { createTerminalTabReadiness } from "./terminal-tab-readiness.ts";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";

/** Owns gateway PTY sessions and the Ghostty controllers bound to them. */
export function createTerminalPanelSessions(host: TerminalPanelSessionHost) {
  const state: TerminalPanelSessionState = {
    tabs: [],
    activeId: null,
    booting: false,
    error: null,
  };
  let ownedConnection: TerminalConnection | null = null;
  let ownedActiveClient: TerminalGatewayClient | null = null;
  let ownedActiveAvailable = false;
  let ownedHadClient = false;
  let ownedHadAvailable = false;
  let ownedLifecycleGeneration = 0;
  let ownedLifecycleAbortController = new AbortController();
  let ownedTabSequence = 0;
  let ownedActiveConnected = true;
  let ownedActiveRecoveryScope: string | undefined;
  let ownedRecoveryRetired = false;
  let ownedLifecycleSyncToken = 0;
  let ownedIntentQueue = terminalIntentQueue;
  const ownedBootQueue = new TerminalTaskQueue();
  function updateState(next: Partial<TerminalPanelSessionState>): void {
    Object.assign(state, next);
    host.publish();
  }

  function synchronizeLifecycle(): void {
    const recoveryScope = host.inputs.client?.recoveryScope;
    const recoveryRetired = host.inputs.client?.offlineRecoveryRetired === true;
    const identityChanged =
      (host.inputs.client?.recoveryScopeReady !== false &&
        ownedActiveRecoveryScope !== undefined &&
        recoveryScope !== ownedActiveRecoveryScope) ||
      (recoveryRetired && !ownedRecoveryRetired);
    const clientChanged = host.inputs.client !== ownedActiveClient || identityChanged;
    const availabilityChanged = host.inputs.available !== ownedActiveAvailable;
    const connectionChanged = host.inputs.gatewayConnected !== ownedActiveConnected;
    if (!clientChanged && !availabilityChanged && !connectionChanged) {
      return;
    }
    ownedActiveConnected = host.inputs.gatewayConnected;
    ownedRecoveryRetired = recoveryRetired;
    if (host.inputs.client?.recoveryScopeReady !== false) {
      ownedActiveRecoveryScope = recoveryScope;
    }
    const resuming = !clientChanged && connectionChanged && host.inputs.available;
    const becameAvailable = availabilityChanged && host.inputs.available && ownedHadAvailable;
    const priorEpoch = (clientChanged && ownedHadClient) || becameAvailable;
    const reconnecting = host.inputs.client !== null && priorEpoch;
    if (clientChanged) {
      recovery.retireIdentity(identityChanged);
      if (identityChanged) {
        ownedIntentQueue.cancel(ownedIntentHost);
      }
      ownedActiveClient = host.inputs.client;
      ownedHadClient ||= host.inputs.client !== null;
    }
    ownedActiveAvailable = host.inputs.available;
    ownedHadAvailable ||= host.inputs.available;
    if (clientChanged || (availabilityChanged && !host.inputs.available)) {
      disposeAllTabs();
    }
    let shouldRestore =
      (clientChanged || resuming) && host.inputs.available && host.terminalPanelOpen;
    if (availabilityChanged) {
      if (!host.inputs.available) {
        host.hideTerminalPanelForUnavailableSurface();
      } else if (host.restoreTerminalPanelOpenState()) {
        shouldRestore = true;
      }
    }
    if (!clientChanged && !host.inputs.gatewayConnected) {
      suspendTransport();
      return;
    }
    if (reconnecting || resuming) {
      const operation = resuming ? captureTerminalOperation() : null;
      ownedIntentQueue.refreshBeforeReconnect(
        ownedIntentHost,
        () => host.isConnected,
        shouldRestore ? () => void api.restoreSessions() : undefined,
        operation ? () => resumeTransport(operation) : undefined,
      );
    } else if (shouldRestore) {
      void api.restoreSessions();
    } else {
      void ownedIntentQueue.drain();
    }
  }

  async function attachSessionNow(
    sessionId: string,
    agentOwned: boolean,
    cancelIntent: () => void,
    stagedInput?: TerminalStagedInput,
  ): Promise<boolean> {
    const existing = state.tabs.find(
      (tab) => tab.gatewaySessionId === sessionId && tab.status !== "exited",
    );
    if (existing) {
      if (stagedInput) {
        existing.stagedInput = stagedInput;
      }
      api.switchTo(existing.id);
      return true;
    }
    const operation = captureTerminalOperation(cancelIntent);
    if (!operation) {
      return false;
    }
    updateState({ booting: true, error: null });
    try {
      const attached = await attachSession(
        sessionId,
        operation,
        agentOwned,
        undefined,
        stagedInput,
      );
      if (attached && state.activeId) {
        api.switchTo(state.activeId);
      }
      return attached || isTerminalOperationCurrent(operation);
    } finally {
      if (isTerminalOperationCurrent(operation)) {
        updateState({ booting: false });
      }
    }
  }

  async function bootTab(
    operation: TerminalOperation,
    options: {
      awaitFirstOutput?: boolean;
      restore?: { batch: TerminalRestoreBatch; sessionId: string };
    } = {},
  ) {
    const restore = options.restore?.batch;
    const boot = await bootTerminalPanelSession({
      panel: host,
      connection: connectionFor(operation),
      sequence: ++ownedTabSequence,
      awaitFirstOutput: options.awaitFirstOutput === true,
      isCurrent: () => isTerminalOperationCurrent(operation, restore),
      shouldFocusOnOpen: restore && (() => !restore.input.interacted),
      onReady: (tab) => ownedReadiness.markReady(tab),
      onExit: (tab, info) => handleExit(tab.id, info),
      captureDeliveryError: (tab) => captureDeliveryError(tab),
    });
    if (!isTerminalOperationCurrent(operation, options.restore?.batch)) {
      disposeTerminalController(boot.tab.controller, boot.tab.host);
      throw new Error("terminal operation cancelled");
    }
    // Replay and close can precede adoption; associate the placeholder privately,
    // without making an unadopted gatewaySessionId usable by input or resize.
    options.restore?.batch.pending.set(options.restore.sessionId, boot.tab);
    boot.tab.cancelPendingIntent = operation.cancelIntent;
    const activeId = restore?.input.interacted ? (state.activeId ?? boot.tab.id) : boot.tab.id;
    updateState({ tabs: [...state.tabs, boot.tab], activeId });
    return boot;
  }

  function adoptSession(
    tab: TerminalPanelSessionTab,
    result: TerminalOpenResult,
    agentOwned = false,
  ): void {
    const reportDeliveryError = captureDeliveryError(tab);
    recovery.retireTab(tab);
    adoptTerminalPanelSession({
      tab,
      result,
      agentOwned,
      connection: ownedConnection,
      readiness: ownedReadiness,
      onDeliveryError: reportDeliveryError,
    });
    updateState({ tabs: [...state.tabs] });
    recovery.persist();
  }

  function removeTab(tab: TerminalPanelSessionTab): void {
    disposeTab(tab);
    const tabs = state.tabs.filter((entry) => entry.id !== tab.id);
    updateState({
      tabs,
      activeId: state.activeId === tab.id ? (tabs.at(-1)?.id ?? null) : state.activeId,
    });
  }

  const { openSessionNow, attachSession } = createTerminalSessionBootOperations({
    host,
    state,
    captureTerminalOperation,
    isTerminalOperationCurrent,
    updateState,
    bootTab,
    adoptSession,
    discardCancelledTab,
    removeTab,
    setError: (text, retryAction) => api.setError(text, retryAction),
    replaceConnection: (connection) => {
      ownedConnection?.dispose();
      ownedConnection = connection;
    },
    markExited: (tab, sessionId) => recovery.markExited(tab, sessionId),
  });

  function discardCancelledTab(tab: TerminalPanelSessionTab): void {
    if (state.tabs.includes(tab)) {
      tab.cancelled = "lifecycle";
      removeTab(tab);
    }
  }

  function handleExit(
    tabId: string,
    info: { reason?: string; exitCode: number | null; signal?: number | null; error?: string },
  ): void {
    const tab = state.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    tab.status = "exited";
    tab.exitReason = info.reason;
    tab.exitCode = info.exitCode;
    tab.exitSignal = info.signal;
    // A clean PTY exit (logout, exit, or EOF) uses the same teardown as the tab
    // close action. Keep abnormal exits and panel errors available for inspection.
    if (
      info.reason === "process_exit" &&
      info.exitCode === 0 &&
      !info.signal &&
      !info.error?.trim() &&
      !state.error
    ) {
      api.closeTab(tabId);
      return;
    }
    recovery.retireTab(tab);
    ownedReadiness.stop(tab);
    tab.controller.setReadOnly(true);
    delete tab.pendingOpen;
    if (info.error?.trim()) {
      api.setError(formatUiExternalText(info.error));
    }
    // The connection drops its own sink on exit delivery, so no release() here —
    // the session id may not be recorded yet when an early exit is replayed.
    updateState({ tabs: [...state.tabs] });
    recovery.persist();
  }

  function closeEmptyPanel(): void {
    // Fullscreen documents (mobile WebViews) have no toggle to reopen a closed
    // panel, so closing the last tab keeps the panel with an empty tab strip
    // (the "+" button stays reachable) instead of leaving a dead blank page.
    if (state.tabs.length === 0 && !host.inputs.fullscreen && !ownedIntentQueue.hasActions) {
      host.closeTerminalPanel();
    }
  }

  function captureTerminalOperation(cancelIntent?: () => void): TerminalOperation | null {
    const client = host.inputs.client;
    if (
      ownedIntentQueue.fenced ||
      !client ||
      client !== ownedActiveClient ||
      !host.inputs.available ||
      !host.inputs.gatewayConnected ||
      !host.isConnected
    ) {
      return null;
    }
    return {
      generation: ownedLifecycleGeneration,
      client,
      signal: ownedLifecycleAbortController.signal,
      cancelIntent,
    };
  }

  function isTerminalOperationCurrent(
    operation: TerminalOperation,
    restore?: TerminalRestoreBatch,
    tab?: TerminalPanelSessionTab,
  ): boolean {
    return (
      host.isConnected &&
      host.inputs.available &&
      host.inputs.gatewayConnected &&
      host.inputs.client === operation.client &&
      ownedActiveClient === operation.client &&
      ownedLifecycleGeneration === operation.generation &&
      (!restore || recovery.currentBatch === restore) &&
      tab?.cancelled !== "close" &&
      !operation.signal.aborted
    );
  }

  function connectionFor(operation: TerminalOperation): TerminalConnection {
    if (!isTerminalOperationCurrent(operation)) {
      throw new Error("terminal operation cancelled");
    }
    return (ownedConnection ??= new TerminalConnection(operation.client));
  }

  function disposeTab(tab: TerminalPanelSessionTab): void {
    ownedReadiness.stop(tab);
    disposeTerminalController(tab.controller, tab.host);
  }

  function disposeAllTabs(): void {
    retireOperations();
    if (state.error?.retryAction) {
      api.setError(state.error.text);
    }
    updateState({ booting: false });
    host.terminalPanelUploadController.dispose();
    for (const tab of state.tabs) {
      // No terminal.close here: this teardown runs for disconnects,
      // availability loss, and element removal — exactly the sessions the
      // persisted-id reattach flow recovers afterwards. Deliberate closes go
      // through closeTab(); sessions nobody reattaches are bounded by the
      // server's detach reaper.
      // The cancelled flag covers a tab whose open RPC is still in flight; its
      // continuation closes the fresh session instead of adopting the
      // disposed terminal.
      tab.cancelled = "lifecycle";
      disposeTab(tab);
    }
    updateState({ tabs: [], activeId: null });
    host.resetTerminalSessionPicker();
    // Drop the gateway subscription with the tabs so the listener never outlives
    // the connection (disconnect/disable/element-removal all route through here).
    ownedConnection?.dispose();
    ownedConnection = null;
  }
  function suspendTransport(): void {
    retireOperations();
    ownedConnection?.suspend();
    for (const tab of state.tabs) {
      tab.pendingInput.drain();
      const awaitFirstOutput = tab.awaitFirstOutput;
      ownedReadiness.stop(tab);
      tab.awaitFirstOutput = awaitFirstOutput;
      if (!tab.gatewaySessionId) {
        tab.cancelled = "lifecycle";
        removeTab(tab);
      } else {
        tab.controller.setReadOnly(true);
      }
    }
    host.terminalPanelUploadController.suspend();
    updateState({ booting: false });
  }

  async function resumeTransport(operation = captureTerminalOperation()): Promise<void> {
    if (!operation) {
      return;
    }
    try {
      await recovery.resume(operation, (tab) => {
        ownedReadiness.arm(tab);
        tab.controller.setReadOnly(tab.status === "exited");
        if (tab.status !== "exited") {
          const { cols, rows } = tab.controller.terminal;
          void ownedConnection
            ?.resize(tab.gatewaySessionId, cols || 80, rows || 24)
            .catch(captureDeliveryError(tab));
        }
      });
      if (!isTerminalOperationCurrent(operation)) {
        return;
      }
      if (host.terminalPanelOpen) {
        await api.restoreSessions();
      } else {
        void ownedIntentQueue.drain();
      }
    } catch (error) {
      if (isTerminalOperationCurrent(operation)) {
        api.setError(`${t("terminal.attachFailed")}: ${formatUiError(error)}`, { kind: "resume" });
      }
    }
    host.publish();
  }

  const captureDeliveryError = (tab: TerminalPanelSessionTab) =>
    captureTerminalDeliveryError(host, state, ownedActiveClient, tab, (text) => api.setError(text));

  function retireOperations(): void {
    ownedLifecycleGeneration += 1;
    recovery.retireBatch();
    ownedIntentQueue.resetLifecycle(ownedIntentHost);
    ownedLifecycleAbortController.abort();
    ownedLifecycleAbortController = new AbortController();
    ownedBootQueue.reset();
  }

  const api = {
    state,
    setError(text: string | null, retryAction?: TerminalPanelError["retryAction"]) {
      updateState({ error: text ? { text, retryAction } : null });
      return state.error;
    },
    retryOpen(): void {
      const action = state.error?.retryAction;
      if (!action) {
        return;
      }
      api.setError(null);
      if (action.kind === "resume") {
        void resumeTransport();
        return;
      }
      void ownedIntentQueue.queue(action);
    },
    connectHost(): void {
      if (host.inputs.page) {
        ownedIntentQueue = createTerminalIntentQueue(false);
      }
      ownedActiveClient = host.inputs.client;
      ownedActiveRecoveryScope =
        host.inputs.client?.recoveryScopeReady === false
          ? undefined
          : host.inputs.client?.recoveryScope;
      ownedRecoveryRetired = host.inputs.client?.offlineRecoveryRetired === true;
      ownedActiveAvailable = host.inputs.available;
      ownedActiveConnected = host.inputs.gatewayConnected;
      ownedHadClient = host.inputs.client !== null;
      ownedHadAvailable = host.inputs.available;
      // Latest mount executes: on a session route the side-panel terminal takes
      // the queue over from the shell instance still held for the bottom dock.
      api.activateHost();
      // Read after binding: the queue reloads its persisted record for the first
      // panel in a document, so an earlier read would miss a carried-over intent.
      updateState({ booting: ownedIntentQueue.hasActions });
    },
    /** A retained standalone dock can become the destination without remounting. */
    activateHost(): void {
      ownedIntentQueue.bindHost(ownedIntentHost);
    },
    get canHandoffSessions(): boolean {
      return ownedIntentQueue.canHandoff(state);
    },
    handoffSessions(): boolean {
      if (!api.canHandoffSessions) {
        return false;
      }
      state.tabs = ownedIntentQueue.queueHandoff(state, ownedActiveClient);
      // Retire the source's views, not its PTYs: a retained shell must not replay
      // stale tabs or selection when a later docking cycle makes it visible again.
      disposeAllTabs();
      return true;
    },
    disconnectHost(): void {
      ownedIntentQueue.releaseHost(ownedIntentHost);
      disposeAllTabs();
      ownedActiveClient = null;
      ownedActiveAvailable = false;
    },
    scheduleLifecycleSync(): void {
      const token = ++ownedLifecycleSyncToken;
      const generation = ownedLifecycleGeneration;
      // State teardown during the render commit can schedule a nested update.
      // Defer it; token + generation reject superseded connection epochs.
      queueMicrotask(() => {
        if (
          token !== ownedLifecycleSyncToken ||
          generation !== ownedLifecycleGeneration ||
          !host.isConnected
        ) {
          return;
        }
        synchronizeLifecycle();
      });
    },
    restoreSessions(): Promise<void> {
      return ownedIntentQueue.queue({
        kind: "restore",
        agentId: host.inputs.agentId?.trim() || null,
      });
    },
    cancelPendingActions(): void {
      ownedIntentQueue.cancel(ownedIntentHost);
    },
    get waitingForRefresh(): boolean {
      return ownedIntentQueue.waitingForRefresh;
    },
    async listSessions(
      options: TerminalSessionListOptions = {},
    ): Promise<TerminalSessionInfo[] | null> {
      const operation = captureTerminalOperation();
      if (!operation) {
        return null;
      }
      if (!options.preserveError) {
        api.setError(null);
      }
      try {
        const sessions = await connectionFor(operation).list();
        return isTerminalOperationCurrent(operation) ? sessions : null;
      } catch (error) {
        // Automatic discovery must not replace an operation's error/retry with
        // a secondary listing failure. The session owner remains authoritative.
        if (isTerminalOperationCurrent(operation) && (!options.preserveError || !state.error)) {
          throw error;
        }
        return null;
      }
    },
    attachSessionById(sessionId: string, agentOwned = false): Promise<void> {
      return ownedIntentQueue.queue({ kind: "attach", sessionId, agentOwned });
    },
    openSession(): Promise<void> {
      return ownedIntentQueue.queue({ kind: "open", agentId: host.inputs.agentId?.trim() || null });
    },
    closeTab(tabId: string): void {
      const tab = state.tabs.find((entry) => entry.id === tabId);
      // A live PTY stays recoverable until its close can reach the Gateway.
      if (!tab || (!host.inputs.gatewayConnected && tab.status !== "exited")) {
        return;
      }
      tab.cancelled = "close";
      recovery.forgetSession(tab.gatewaySessionId);
      tab.cancelPendingIntent?.();
      recovery.retireTab(tab);
      host.terminalPanelUploadController.cancelForTab(tab);
      if (tab.gatewaySessionId && tab.status !== "exited") {
        void ownedConnection?.close(tab.gatewaySessionId);
      }
      removeTab(tab);
      recovery.persist();
      closeEmptyPanel();
    },
    switchTo(tabId: string): void {
      updateState({ activeId: tabId });
      const tab = state.tabs.find((entry) => entry.id === tabId);
      void focusTerminalSession(tab, host.updateComplete);
    },
  };

  const recovery = new TerminalPanelSessionRecovery({
    storageScope: () =>
      host.inputs.page ? `:page:${JSON.stringify(host.inputs.routeTarget)}` : "",
    ownerDocument: () => host.inputs.ownerDocument,
    tabs: () => state.tabs,
    captureOperation: () => captureTerminalOperation(),
    connectionFor: (operation) => connectionFor(operation),
    isCurrent: (operation, restore) => isTerminalOperationCurrent(operation, restore),
    attach: (sessionId, operation, agentOwned, restore) =>
      attachSession(sessionId, operation, agentOwned, restore),
    boot: (sessionId, restore) =>
      bootTab(restore.operation, { restore: { batch: restore, sessionId } }),
    discard: (tab) => discardCancelledTab(tab),
    exited: (tab) => handleExit(tab.id, { reason: "disconnected", exitCode: null }),
    setBooting: (booting) => updateState({ booting }),
    setError: (text) => api.setError(text),
  });

  let refreshError: TerminalPanelError | null = null;
  const ownedIntentHost: TerminalIntentHost = {
    bootQueue: ownedBootQueue,
    currentGeneration: () => ownedLifecycleGeneration,
    canRun: () =>
      host.inputs.client !== null &&
      host.inputs.client === ownedActiveClient &&
      host.inputs.available &&
      host.inputs.gatewayConnected &&
      // Closed lazy shells must not consume work without a rendered viewport.
      host.terminalPanelOpen &&
      host.isConnected,
    attach: (sessionId, agentOwned, cancel, stagedInput) => {
      host.resetTerminalSessionPicker();
      return attachSessionNow(sessionId, agentOwned, cancel, stagedInput);
    },
    client: () => ownedActiveClient,
    showError: (text) => api.setError(text),
    present: (tab) => {
      host.resetTerminalSessionPicker();
      tab.id = `tab-${++ownedTabSequence}`;
      updateState({ tabs: [...state.tabs, tab], booting: false });
      api.switchTo(tab.id);
    },
    open: (catalog, agentId, cancel) => {
      // Only admitted explicit intents use this callback. Generic restore opens
      // through ensureInitial and keeps the approved desktop list presentation.
      host.resetTerminalSessionPicker();
      return openSessionNow(catalog, agentId, cancel);
    },
    reattach: (cancel) => recovery.reattach(cancel),
    cancelledRestoreCompleted: () => {
      if (!state.error) {
        closeEmptyPanel();
      }
    },
    ensureInitial: async (agentId, cancel) => {
      if (state.tabs.length === 0) {
        const target = host.inputs.page ? host.inputs.routeTarget : null;
        return target && "sessionId" in target
          ? attachSessionNow(target.sessionId, false, cancel)
          : openSessionNow(target?.catalog, agentId, cancel);
      }
      return ownedIntentHost.canRun();
    },
    hasTabs: () => state.tabs.length > 0,
    publish: () => host.publish(),
    setBooting: (booting) => updateState({ booting }),
    showTimeout: () => {
      refreshError = api.setError(t("terminal.refreshRequired"));
    },
    clearTimeout: () => {
      if (refreshError && state.error === refreshError) {
        api.setError(null);
      }
      refreshError = null;
    },
  };
  const ownedReadiness = createTerminalTabReadiness<TerminalPanelSessionTab>({
    isCurrent: (tab) => state.tabs.includes(tab),
    onReady: (tab) => {
      delete tab.pendingOpen;
      updateState({ tabs: [...state.tabs] });
      recovery.persist();
    },
    onTimeout: (tab) => {
      api.setError(t("terminal.connectionTimedOut"), tab.pendingOpen);
      void ownedConnection?.close(tab.gatewaySessionId);
      removeTab(tab);
      recovery.persist();
    },
  });

  return api;
}
