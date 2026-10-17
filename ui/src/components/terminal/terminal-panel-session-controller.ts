import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { takePreparedCatalogTerminal } from "../../lib/sessions/catalog-terminal-start.ts";
import {
  TerminalConnection,
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
  type TerminalGatewayClient,
  type TerminalOpenResult,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import { disposeTerminalController } from "./terminal-controller-lifecycle.ts";
import { terminalOpenErrorText } from "./terminal-panel-chrome.ts";
import {
  adoptTerminalPanelSession,
  bootTerminalPanelSession,
} from "./terminal-panel-session-boot.ts";
import { TerminalPanelSessionRecovery } from "./terminal-panel-session-recovery.ts";
import { focusTerminalSession } from "./terminal-panel-session-rendering.ts";
import {
  resolveTerminalPanelOwnerSessionKey,
  type TerminalOperation,
  type TerminalPanelError,
  type TerminalPanelOpenAction,
  type TerminalPanelSessionControllerHost,
  type TerminalPanelSessionControllerState,
  type TerminalPanelSessionTab,
  type TerminalRestoreBatch,
} from "./terminal-panel-session-types.ts";
import { TerminalIntentQueue, terminalIntentQueue } from "./terminal-pending-actions.ts";
import type { TerminalIntentHost } from "./terminal-pending-actions.ts";
import { TerminalTabReadinessController } from "./terminal-tab-readiness.ts";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";

/** Owns gateway PTY sessions and the Ghostty controllers bound to them. */
export class TerminalPanelSessionController implements TerminalPanelSessionControllerState {
  tabs: TerminalPanelSessionTab[] = [];
  activeId: string | null = null;
  booting = false;
  error: TerminalPanelError | null = null;

  private connection: TerminalConnection | null = null;
  private activeClient: TerminalGatewayClient | null = null;
  private activeAvailable = false;
  private activeConnected = true;
  private activeRecoveryScope: string | undefined;
  private recoveryRetired = false;
  private hadClient = false;
  private hadAvailable = false;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();
  private lifecycleSyncToken = 0;
  private tabSequence = 0;
  private readonly recovery: TerminalPanelSessionRecovery;
  private intentQueue = terminalIntentQueue;
  private readonly bootQueue = new TerminalTaskQueue();
  private readonly intentHost: TerminalIntentHost;
  private readonly readiness: TerminalTabReadinessController<TerminalPanelSessionTab>;

  constructor(private readonly host: TerminalPanelSessionControllerHost) {
    this.recovery = new TerminalPanelSessionRecovery({
      storageScope: () => (this.host.page ? `:page:${JSON.stringify(this.host.routeTarget)}` : ""),
      ownerDocument: () => this.host.ownerDocument,
      tabs: () => this.tabs,
      captureOperation: () => this.captureTerminalOperation(),
      connectionFor: (operation) => this.connectionFor(operation),
      isCurrent: (operation, restore) => this.isTerminalOperationCurrent(operation, restore),
      attach: (sessionId, operation, agentOwned, restore) =>
        this.attachSession(sessionId, operation, agentOwned, restore),
      boot: (sessionId, restore) =>
        this.bootTab(restore.operation, { restore: { batch: restore, sessionId } }),
      discard: (tab) => this.discardCancelledTab(tab),
      exited: (tab) => this.handleExit(tab.id, { reason: "disconnected", exitCode: null }),
      setBooting: (booting) => this.updateControllerState({ booting }),
      setError: (text) => this.setError(text),
    });
    let refreshError: TerminalPanelError | null = null;
    this.intentHost = {
      bootQueue: this.bootQueue,
      currentGeneration: () => this.lifecycleGeneration,
      canRun: () =>
        this.host.client !== null &&
        this.host.client === this.activeClient &&
        this.host.available &&
        this.host.gatewayConnected &&
        // Closed lazy shells must not consume work without a rendered viewport.
        this.host.terminalPanelOpen &&
        this.host.isConnected,
      attach: (sessionId, agentOwned, cancel) =>
        this.attachSessionNow(sessionId, agentOwned, cancel),
      client: () => this.activeClient,
      showError: (text) => this.setError(text),
      present: (tab) => {
        tab.id = `tab-${++this.tabSequence}`;
        this.updateControllerState({ tabs: [...this.tabs, tab], booting: false });
        this.switchTo(tab.id);
      },
      open: (catalog, agentId, cancel) => this.openSessionNow(catalog, agentId, cancel),
      reattach: (cancel) => this.recovery.reattach(cancel),
      cancelledRestoreCompleted: () => {
        if (!this.error) {
          this.closeEmptyPanel();
        }
      },
      ensureInitial: async (agentId, cancel) => {
        if (this.tabs.length === 0) {
          const target = this.host.page ? this.host.routeTarget : null;
          return target && "sessionId" in target
            ? this.attachSessionNow(target.sessionId, false, cancel)
            : this.openSessionNow(target?.catalog, agentId, cancel);
        }
        return this.intentHost.canRun();
      },
      hasTabs: () => this.tabs.length > 0,
      requestUpdate: () => this.host.requestUpdate(),
      setBooting: (booting) => this.updateControllerState({ booting }),
      timeoutMs: () => this.host.catalogReadyTimeoutMs,
      showTimeout: () => {
        refreshError = this.setError(t("terminal.refreshRequired"));
      },
      clearTimeout: () => {
        if (refreshError && this.error === refreshError) {
          this.setError(null);
        }
        refreshError = null;
      },
    };
    this.readiness = new TerminalTabReadinessController<TerminalPanelSessionTab>({
      timeoutMs: () => this.host.catalogReadyTimeoutMs,
      isCurrent: (tab) => this.tabs.includes(tab),
      onReady: (tab) => {
        delete tab.pendingOpen;
        this.updateControllerState({ tabs: [...this.tabs] });
        this.recovery.persist();
      },
      onTimeout: (tab) => {
        this.setError(t("terminal.connectionTimedOut"), tab.pendingOpen);
        void this.connection?.close(tab.gatewaySessionId);
        this.removeTab(tab);
        this.recovery.persist();
      },
    });
  }

  private updateControllerState(state: Partial<TerminalPanelSessionControllerState>): void {
    Object.assign(this, state);
    this.host.requestUpdate();
  }

  setError(
    text: string | null,
    retryAction?: TerminalPanelError["retryAction"],
  ): TerminalPanelError | null {
    this.updateControllerState({ error: text ? { text, retryAction } : null });
    return this.error;
  }

  retryOpen(): void {
    const action = this.error?.retryAction;
    if (!action) {
      return;
    }
    this.setError(null);
    if (action.kind === "resume") {
      void this.resumeTransport();
      return;
    }
    void this.intentQueue.queue(action);
  }

  connectHost(): void {
    if (this.host.page) {
      this.intentQueue = new TerminalIntentQueue(false);
    }
    this.activeClient = this.host.client;
    this.activeRecoveryScope =
      this.host.client?.recoveryScopeReady === false ? undefined : this.host.client?.recoveryScope;
    this.recoveryRetired = this.host.client?.offlineRecoveryRetired === true;
    this.activeAvailable = this.host.available;
    this.activeConnected = this.host.gatewayConnected;
    this.hadClient = this.host.client !== null;
    this.hadAvailable = this.host.available;
    // Latest mount executes: on a session route the side-panel terminal takes
    // the queue over from the shell instance still held for the bottom dock.
    this.activateHost();
    // Read after binding: the queue reloads its persisted record for the first
    // panel in a document, so an earlier read would miss a carried-over intent.
    this.updateControllerState({ booting: this.intentQueue.hasActions });
  }

  /** A retained standalone dock can become the destination without remounting. */
  activateHost(): void {
    this.intentQueue.bindHost(this.intentHost);
  }

  get canHandoffSessions(): boolean {
    return this.intentQueue.canHandoff(this);
  }

  handoffSessions(): boolean {
    if (!this.canHandoffSessions) {
      return false;
    }
    this.tabs = this.intentQueue.queueHandoff(this, this.activeClient);
    // Retire the source's views, not its PTYs: a retained shell must not replay
    // stale tabs or selection when a later docking cycle makes it visible again.
    this.disposeAllTabs();
    return true;
  }

  disconnectHost(): void {
    this.intentQueue.releaseHost(this.intentHost);
    this.disposeAllTabs();
    this.activeClient = null;
    this.activeAvailable = false;
  }

  scheduleLifecycleSync(): void {
    const token = ++this.lifecycleSyncToken;
    const generation = this.lifecycleGeneration;
    // State teardown during the render commit can schedule a nested update.
    // Defer it; token + generation reject superseded connection epochs.
    queueMicrotask(() => {
      if (
        token !== this.lifecycleSyncToken ||
        generation !== this.lifecycleGeneration ||
        !this.host.isConnected
      ) {
        return;
      }
      this.synchronizeLifecycle();
    });
  }

  private synchronizeLifecycle(): void {
    const recoveryScope = this.host.client?.recoveryScope;
    const recoveryRetired = this.host.client?.offlineRecoveryRetired === true;
    const identityChanged =
      (this.host.client?.recoveryScopeReady !== false &&
        this.activeRecoveryScope !== undefined &&
        recoveryScope !== this.activeRecoveryScope) ||
      (recoveryRetired && !this.recoveryRetired);
    const clientChanged = this.host.client !== this.activeClient || identityChanged;
    const availabilityChanged = this.host.available !== this.activeAvailable;
    const connectionChanged = this.host.gatewayConnected !== this.activeConnected;
    if (!clientChanged && !availabilityChanged && !connectionChanged) {
      return;
    }
    this.activeConnected = this.host.gatewayConnected;
    this.recoveryRetired = recoveryRetired;
    if (this.host.client?.recoveryScopeReady !== false) {
      this.activeRecoveryScope = recoveryScope;
    }
    const resuming = !clientChanged && connectionChanged && this.host.available;
    const becameAvailable = availabilityChanged && this.host.available && this.hadAvailable;
    const priorEpoch = (clientChanged && this.hadClient) || becameAvailable;
    const reconnecting = this.host.client !== null && priorEpoch;
    if (clientChanged) {
      this.recovery.retireIdentity(identityChanged);
      if (identityChanged) {
        this.intentQueue.cancel(this.intentHost);
      }
      this.activeClient = this.host.client;
      this.hadClient ||= this.host.client !== null;
    }
    this.activeAvailable = this.host.available;
    this.hadAvailable ||= this.host.available;
    const becameUnavailable = availabilityChanged && !this.host.available;
    if (clientChanged || becameUnavailable) {
      this.disposeAllTabs();
    }
    let shouldRestore =
      (clientChanged || resuming) && this.host.available && this.host.terminalPanelOpen;
    if (availabilityChanged) {
      if (!this.host.available) {
        this.host.hideTerminalPanelForUnavailableSurface();
      } else if (this.host.restoreTerminalPanelOpenState()) {
        shouldRestore = true;
      }
    }
    if (!clientChanged && !this.host.gatewayConnected) {
      this.suspendTransport();
      return;
    }
    if (reconnecting || resuming) {
      const operation = resuming ? this.captureTerminalOperation() : null;
      this.intentQueue.refreshBeforeReconnect(
        this.intentHost,
        () => this.host.isConnected,
        shouldRestore ? () => void this.restoreSessions() : undefined,
        operation ? () => this.resumeTransport(operation) : undefined,
      );
    } else if (shouldRestore) {
      void this.restoreSessions();
    } else {
      void this.intentQueue.drain();
    }
  }

  private suspendTransport(): void {
    this.retireOperations();
    this.connection?.suspend();
    for (const tab of this.tabs) {
      tab.pendingInput.drain();
      const awaitFirstOutput = tab.awaitFirstOutput;
      this.readiness.stop(tab);
      tab.awaitFirstOutput = awaitFirstOutput;
      if (!tab.gatewaySessionId) {
        tab.cancelled = "lifecycle";
        this.removeTab(tab);
      } else {
        tab.controller.setReadOnly(true);
      }
    }
    this.host.terminalPanelUploadController.suspend();
    this.updateControllerState({ booting: false });
  }

  private async resumeTransport(operation = this.captureTerminalOperation()): Promise<void> {
    if (!operation) {
      return;
    }
    try {
      await this.recovery.resume(operation, (tab) => {
        this.readiness.arm(tab);
        tab.controller.setReadOnly(tab.status === "exited");
        if (tab.status !== "exited") {
          const { cols, rows } = tab.controller.terminal;
          void this.connection
            ?.resize(tab.gatewaySessionId, cols || 80, rows || 24)
            .catch(this.captureDeliveryError(tab));
        }
      });
      if (!this.isTerminalOperationCurrent(operation)) {
        return;
      }
      if (this.host.terminalPanelOpen) {
        await this.restoreSessions();
      } else {
        void this.intentQueue.drain();
      }
    } catch (error) {
      if (this.isTerminalOperationCurrent(operation)) {
        this.setError(`${t("terminal.attachFailed")}: ${formatUiError(error)}`, { kind: "resume" });
      }
    }
    this.host.requestUpdate();
  }

  restoreSessions(): Promise<void> {
    return this.intentQueue.queue({ kind: "restore", agentId: this.host.agentId?.trim() || null });
  }

  cancelPendingActions(): void {
    this.intentQueue.cancel(this.intentHost);
  }

  get waitingForRefresh(): boolean {
    return this.intentQueue.waitingForRefresh;
  }

  listSessions(): Promise<TerminalSessionInfo[] | null> {
    return this.recovery.listSessions();
  }

  attachSessionById(sessionId: string, agentOwned = false): Promise<void> {
    return this.intentQueue.queue({ kind: "attach", sessionId, agentOwned });
  }

  private async attachSessionNow(
    sessionId: string,
    agentOwned: boolean,
    cancelIntent: () => void,
  ): Promise<boolean> {
    const existing = this.tabs.find(
      (tab) => tab.gatewaySessionId === sessionId && tab.status !== "exited",
    );
    if (existing) {
      this.switchTo(existing.id);
      return true;
    }
    const operation = this.captureTerminalOperation(cancelIntent);
    if (!operation) {
      return false;
    }
    this.updateControllerState({ booting: true, error: null });
    try {
      const attached = await this.attachSession(sessionId, operation, agentOwned);
      if (attached && this.activeId) {
        this.switchTo(this.activeId);
      }
      return attached || this.isTerminalOperationCurrent(operation);
    } finally {
      if (this.isTerminalOperationCurrent(operation)) {
        this.updateControllerState({ booting: false });
      }
    }
  }

  private async bootTab(
    operation: TerminalOperation,
    options: {
      awaitFirstOutput?: boolean;
      restore?: { batch: TerminalRestoreBatch; sessionId: string };
    } = {},
  ) {
    const restore = options.restore?.batch;
    const boot = await bootTerminalPanelSession({
      panel: this.host,
      connection: this.connectionFor(operation),
      sequence: ++this.tabSequence,
      awaitFirstOutput: options.awaitFirstOutput === true,
      isCurrent: () => this.isTerminalOperationCurrent(operation, restore),
      shouldFocusOnOpen: restore && (() => !restore.input.interacted),
      onReady: (tab) => this.readiness.markReady(tab),
      onExit: (tab, info) => this.handleExit(tab.id, info),
      captureDeliveryError: (tab) => this.captureDeliveryError(tab),
    });
    if (!this.isTerminalOperationCurrent(operation, options.restore?.batch)) {
      disposeTerminalController(boot.tab.controller, boot.tab.host);
      throw new Error("terminal operation cancelled");
    }
    // Replay and close can precede adoption; associate the placeholder privately,
    // without making an unadopted gatewaySessionId usable by input or resize.
    options.restore?.batch.pending.set(options.restore.sessionId, boot.tab);
    boot.tab.cancelPendingIntent = operation.cancelIntent;
    const activeId = restore?.input.interacted ? (this.activeId ?? boot.tab.id) : boot.tab.id;
    this.updateControllerState({ tabs: [...this.tabs, boot.tab], activeId });
    return boot;
  }

  private adoptSession(
    tab: TerminalPanelSessionTab,
    result: TerminalOpenResult,
    agentOwned = false,
  ): void {
    const reportDeliveryError = this.captureDeliveryError(tab);
    this.recovery.retireTab(tab);
    adoptTerminalPanelSession({
      tab,
      result,
      agentOwned,
      connection: this.connection,
      readiness: this.readiness,
      onDeliveryError: reportDeliveryError,
    });
    this.updateControllerState({ tabs: [...this.tabs] });
    this.recovery.persist();
  }

  private removeTab(tab: TerminalPanelSessionTab): void {
    this.disposeTab(tab);
    const tabs = this.tabs.filter((entry) => entry.id !== tab.id);
    this.updateControllerState({
      tabs,
      activeId: this.activeId === tab.id ? (tabs.at(-1)?.id ?? null) : this.activeId,
    });
  }

  private captureDeliveryError(tab: TerminalPanelSessionTab): () => void {
    // Delivery uncertainty belongs to the retained tab and identity, not the transport epoch.
    const client = this.activeClient;
    const recoveryScope = client?.recoveryScope;
    return () => {
      if (
        this.host.isConnected &&
        this.host.client === client &&
        client?.recoveryScope === recoveryScope &&
        !client?.offlineRecoveryRetired &&
        this.tabs.includes(tab)
      ) {
        this.setError(t("terminal.deliveryFailed"));
      }
    };
  }

  openSession(): Promise<void> {
    return this.intentQueue.queue({ kind: "open", agentId: this.host.agentId?.trim() || null });
  }

  private async openSessionNow(
    catalog: CatalogSessionKey | undefined,
    agentId: string | null,
    cancelIntent: () => void,
  ): Promise<boolean> {
    const operation = this.captureTerminalOperation(cancelIntent);
    if (!operation) {
      return false;
    }
    this.updateControllerState({ booting: true, error: null });
    const action: TerminalPanelOpenAction = catalog
      ? { kind: "catalog", agentId, catalog }
      : { kind: "open", agentId };
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const ownerSessionKey = resolveTerminalPanelOwnerSessionKey(this.host.sessionKey, catalog);
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalPanelSessionTab | undefined;
    try {
      const boot = await this.bootTab(operation, { awaitFirstOutput: Boolean(catalog) });
      createdTab = boot.tab;
      boot.tab.pendingOpen = action;
      const result = await boot.connection.open(
        {
          agentId: agentId ?? undefined,
          ...(ownerSessionKey ? { sessionKey: ownerSessionKey } : {}),
          cols: boot.cols,
          rows: boot.rows,
          ...(catalog ? { catalog } : {}),
        },
        boot.sink,
      );
      if (!this.isTerminalOperationCurrent(operation) || boot.tab.cancelled) {
        const cancelledByUser = boot.tab.cancelled === "close";
        // The tab's close button was clicked while the open RPC was in flight.
        // The server session is live and its sink registered; close it now or
        // it survives invisibly (eating the session cap) until disconnect.
        void boot.connection.close(result.sessionId);
        this.discardCancelledTab(boot.tab);
        return cancelledByUser;
      }
      this.adoptSession(boot.tab, result, ownerSessionKey !== undefined);
      boot.tab.controller.terminal.focus();
      return true;
    } catch (error) {
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.removeTab(createdTab);
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return false;
      }
      if (createdTab?.cancelled !== "close") {
        this.setError(
          terminalOpenErrorText(error),
          error instanceof TerminalOpenTimeoutError ||
            error instanceof TerminalOpenUnusableSessionError
            ? action
            : undefined,
        );
      }
      return true;
    } finally {
      if (this.isTerminalOperationCurrent(operation)) {
        this.updateControllerState({ booting: false });
      }
    }
  }

  private async attachSession(
    sessionId: string,
    operation: TerminalOperation,
    agentOwned = false,
    restore?: TerminalRestoreBatch,
  ): Promise<boolean> {
    let createdTab: TerminalPanelSessionTab | undefined;
    let createdConnection: TerminalConnection | undefined;
    const prepared = this.host.page
      ? takePreparedCatalogTerminal(sessionId, operation.client)
      : null;
    try {
      if (prepared) {
        this.connection?.dispose();
        this.connection = prepared.connection;
      }
      const boot = await this.bootTab(operation, {
        awaitFirstOutput: prepared !== null,
        restore: restore && { batch: restore, sessionId },
      });
      createdTab = boot.tab;
      createdConnection = boot.connection;
      if (prepared) {
        prepared.bind(boot.sink);
      }
      const result = prepared?.result ?? (await boot.connection.attach(sessionId, boot.sink));
      if (!this.isTerminalOperationCurrent(operation, restore) || boot.tab.cancelled) {
        // A user close is deliberate; lifecycle cancellation leaves the existing
        // server session available for the next reconnect to reattach.
        if (boot.tab.cancelled === "close") {
          void boot.connection.close(result.sessionId);
        }
        this.discardCancelledTab(boot.tab);
        return false;
      }
      this.adoptSession(boot.tab, result, agentOwned);
      return true;
    } catch (error) {
      // Claiming cancels the handoff expiry; failed boot or binding must close
      // this newly started PTY even if the page lifecycle was also cancelled.
      if (prepared) {
        void prepared.connection.close(prepared.result.sessionId);
      }
      if (!this.isTerminalOperationCurrent(operation, restore, createdTab)) {
        return false;
      }
      // Failed reads cannot turn transport or authorization errors into authoritative exits.
      const sessions =
        restore && createdConnection ? await createdConnection.list().catch(() => null) : null;
      if (!this.isTerminalOperationCurrent(operation, restore, createdTab)) {
        return false;
      }
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        if (sessions && !sessions.some((session) => session.sessionId === sessionId)) {
          this.recovery.markExited(createdTab, sessionId);
        } else {
          this.removeTab(createdTab);
        }
      }
      if (!restore) {
        this.setError(`${t("terminal.attachFailed")}: ${formatUiError(error)}`);
      }
      return false;
    }
  }

  private discardCancelledTab(tab: TerminalPanelSessionTab): void {
    if (this.tabs.includes(tab)) {
      tab.cancelled = "lifecycle";
      this.removeTab(tab);
    }
  }

  private handleExit(
    tabId: string,
    info: { reason?: string; exitCode: number | null; signal?: number | null; error?: string },
  ): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
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
      !this.error
    ) {
      this.closeTab(tabId);
      return;
    }
    this.recovery.retireTab(tab);
    this.readiness.stop(tab);
    tab.controller.setReadOnly(true);
    delete tab.pendingOpen;
    if (info.error?.trim()) {
      this.setError(formatUiExternalText(info.error));
    }
    // The connection drops its own sink on exit delivery, so no release() here —
    // the session id may not be recorded yet when an early exit is replayed.
    this.updateControllerState({ tabs: [...this.tabs] });
    this.recovery.persist();
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    // A live PTY stays recoverable until its close can reach the Gateway.
    if (!tab || (!this.host.gatewayConnected && tab.status !== "exited")) {
      return;
    }
    tab.cancelled = "close";
    this.recovery.forgetSession(tab.gatewaySessionId);
    tab.cancelPendingIntent?.();
    this.recovery.retireTab(tab);
    this.host.terminalPanelUploadController.cancelForTab(tab);
    if (tab.gatewaySessionId && tab.status !== "exited") {
      void this.connection?.close(tab.gatewaySessionId);
    }
    this.removeTab(tab);
    this.recovery.persist();
    this.closeEmptyPanel();
  }

  private closeEmptyPanel(): void {
    // Fullscreen documents (mobile WebViews) have no toggle to reopen a closed
    // panel, so closing the last tab keeps the panel with an empty tab strip
    // (the "+" button stays reachable) instead of leaving a dead blank page.
    if (this.tabs.length === 0 && !this.host.fullscreen && !this.intentQueue.hasActions) {
      this.host.closeTerminalPanel();
    }
  }

  switchTo(tabId: string): void {
    this.updateControllerState({ activeId: tabId });
    const tab = this.tabs.find((entry) => entry.id === tabId);
    void focusTerminalSession(tab, this.host.updateComplete);
  }

  private captureTerminalOperation(cancelIntent?: () => void): TerminalOperation | null {
    const client = this.host.client;
    if (
      this.intentQueue.fenced ||
      !client ||
      client !== this.activeClient ||
      !this.host.available ||
      !this.host.gatewayConnected ||
      !this.host.isConnected
    ) {
      return null;
    }
    return {
      generation: this.lifecycleGeneration,
      client,
      signal: this.lifecycleAbortController.signal,
      cancelIntent,
    };
  }

  private isTerminalOperationCurrent(
    operation: TerminalOperation,
    restore?: TerminalRestoreBatch,
    tab?: TerminalPanelSessionTab,
  ): boolean {
    return (
      this.host.isConnected &&
      this.host.available &&
      this.host.gatewayConnected &&
      this.host.client === operation.client &&
      this.activeClient === operation.client &&
      this.lifecycleGeneration === operation.generation &&
      (!restore || this.recovery.currentBatch === restore) &&
      tab?.cancelled !== "close" &&
      !operation.signal.aborted
    );
  }

  private connectionFor(operation: TerminalOperation): TerminalConnection {
    if (!this.isTerminalOperationCurrent(operation)) {
      throw new Error("terminal operation cancelled");
    }
    this.connection ??= new TerminalConnection(operation.client);
    return this.connection;
  }

  private disposeTab(tab: TerminalPanelSessionTab): void {
    this.readiness.stop(tab);
    disposeTerminalController(tab.controller, tab.host);
  }

  private retireOperations(): void {
    this.lifecycleGeneration += 1;
    this.recovery.retireBatch();
    this.intentQueue.resetLifecycle(this.intentHost);
    this.lifecycleAbortController.abort();
    this.lifecycleAbortController = new AbortController();
    this.bootQueue.reset();
  }

  private disposeAllTabs(): void {
    this.retireOperations();
    if (this.error?.retryAction) {
      this.setError(this.error.text);
    }
    this.updateControllerState({ booting: false });
    this.host.terminalPanelUploadController.dispose();
    for (const tab of this.tabs) {
      // No terminal.close here: this teardown runs for disconnects,
      // availability loss, and element removal — exactly the sessions the
      // persisted-id reattach flow recovers afterwards. Deliberate closes go
      // through closeTab(); sessions nobody reattaches are bounded by the
      // server's detach reaper.
      // The cancelled flag covers a tab whose open RPC is still in flight; its
      // continuation closes the fresh session instead of adopting the
      // disposed terminal.
      tab.cancelled = "lifecycle";
      this.disposeTab(tab);
    }
    this.updateControllerState({ tabs: [], activeId: null });
    this.host.resetTerminalSessionPicker();
    // Drop the gateway subscription with the tabs so the listener never outlives
    // the connection (disconnect/disable/element-removal all route through here).
    this.connection?.dispose();
    this.connection = null;
  }
}
