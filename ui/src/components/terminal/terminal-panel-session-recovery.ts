import { t } from "../../i18n/index.ts";
import { registerTerminalEnglish } from "../../i18n/locales/en-terminal.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { TerminalConnection, TerminalSessionInfo } from "./terminal-connection.ts";
import { observeTerminalRestoreInput } from "./terminal-panel-session-boot.ts";
import type {
  TerminalOperation,
  TerminalPanelSessionTab,
  TerminalRestoreBatch,
} from "./terminal-panel-session-types.ts";
import {
  loadPersistedTerminalSessionIds,
  persistTerminalSessionIds,
} from "./terminal-session-storage.ts";

registerTerminalEnglish();

type TerminalSessionRecoveryHost = {
  storageScope: () => string;
  ownerDocument: () => Document;
  tabs: () => readonly TerminalPanelSessionTab[];
  captureOperation: () => TerminalOperation | null;
  connectionFor: (operation: TerminalOperation) => TerminalConnection;
  isCurrent: (operation: TerminalOperation, restore?: TerminalRestoreBatch) => boolean;
  attach: (
    sessionId: string,
    operation: TerminalOperation,
    agentOwned: boolean,
    restore: TerminalRestoreBatch,
  ) => Promise<boolean>;
  boot: (
    sessionId: string,
    restore: TerminalRestoreBatch,
  ) => Promise<{ tab: TerminalPanelSessionTab }>;
  discard: (tab: TerminalPanelSessionTab) => void;
  exited: (tab: TerminalPanelSessionTab) => void;
  setBooting: (booting: boolean) => void;
  setError: (text: string) => void;
};

/** Owns saved-session custody until discovery confirms attachment, exit, or a deliberate close. */
export class TerminalPanelSessionRecovery {
  private batch: TerminalRestoreBatch | null = null;
  private readonly unresolvedSessionIds = new Set<string>();

  constructor(private readonly host: TerminalSessionRecoveryHost) {}

  get currentBatch(): TerminalRestoreBatch | null {
    return this.batch;
  }

  retireBatch(): void {
    this.batch = null;
  }

  retireIdentity(clearStored: boolean): void {
    this.unresolvedSessionIds.clear();
    if (clearStored) {
      persistTerminalSessionIds([], this.host.storageScope());
    }
  }

  forgetSession(sessionId: string): void {
    this.unresolvedSessionIds.delete(sessionId);
  }

  async listSessions(
    operation = this.host.captureOperation(),
  ): Promise<TerminalSessionInfo[] | null> {
    if (!operation) {
      return null;
    }
    const sessions = await this.host
      .connectionFor(operation)
      .list()
      .catch((error: unknown) => {
        if (this.host.isCurrent(operation)) {
          this.host.setError(`${t("terminal.attachFailed")}: ${formatUiError(error)}`);
        }
        return null;
      });
    return this.host.isCurrent(operation) ? sessions : null;
  }

  async resume(
    operation: TerminalOperation,
    onResumed: (tab: TerminalPanelSessionTab) => void,
  ): Promise<void> {
    const connection = this.host.connectionFor(operation);
    const failures = await connection.resume();
    if (!this.host.isCurrent(operation)) {
      return;
    }
    for (const tab of this.host.tabs()) {
      if (!failures.has(tab.gatewaySessionId)) {
        onResumed(tab);
      }
    }
    if (failures.size === 0) {
      return;
    }
    const listed = await this.listSessions(operation);
    if (!this.host.isCurrent(operation)) {
      return;
    }
    for (const tab of this.host.tabs()) {
      const sessionId = tab.gatewaySessionId;
      if (
        failures.has(sessionId) &&
        listed &&
        !listed.some((session) => session.sessionId === sessionId)
      ) {
        connection.release(sessionId);
        this.markExited(tab, sessionId);
        failures.delete(sessionId);
      }
    }
    if (failures.size > 0) {
      throw failures.values().next().value;
    }
  }

  async reattach(cancelIntent?: () => void): Promise<boolean> {
    const operation = this.host.captureOperation();
    if (!operation) {
      return false;
    }
    const persisted = loadPersistedTerminalSessionIds(this.host.storageScope()).filter(
      (sessionId) => !this.host.tabs().some((tab) => tab.gatewaySessionId === sessionId),
    );
    if (persisted.length === 0) {
      return false;
    }
    for (const sessionId of persisted) {
      this.unresolvedSessionIds.add(sessionId);
    }
    // Readiness can persist an adopted tab while later attaches are still pending.
    const restore: TerminalRestoreBatch = {
      operation,
      pending: new Map(persisted.map((sessionId) => [sessionId, undefined])),
      userClosedTab: false,
      input: observeTerminalRestoreInput(this.host.ownerDocument(), operation.signal),
      cancelIntent,
    };
    this.batch = restore;
    this.host.setBooting(true);
    try {
      const listed = await this.host.connectionFor(operation).list();
      if (!this.host.isCurrent(operation, restore)) {
        return false;
      }
      const known = new Map(listed.map((session) => [session.sessionId, session]));
      for (const sessionId of restore.pending.keys()) {
        const session = known.get(sessionId);
        if (!session) {
          const { tab } = await this.host.boot(sessionId, restore);
          if (!this.host.isCurrent(restore.operation, restore) || tab.cancelled) {
            this.host.discard(tab);
          } else {
            this.markExited(tab, sessionId);
          }
        } else {
          const attached = await this.host.attach(
            sessionId,
            operation,
            session.owner?.startsWith("agent:") === true,
            restore,
          );
          if (!attached && restore.pending.has(sessionId)) {
            throw new Error(t("terminal.attachFailed"));
          }
        }
        if (!this.host.isCurrent(operation, restore)) {
          return false;
        }
        restore.pending.delete(sessionId);
        this.unresolvedSessionIds.delete(sessionId);
        this.persist();
      }
    } catch (error: unknown) {
      if (this.host.isCurrent(operation, restore)) {
        this.host.setError(`${t("terminal.attachFailed")}: ${formatUiError(error)}`);
        return true;
      }
    } finally {
      restore.input.stop();
      if (this.host.isCurrent(operation, restore)) {
        this.batch = null;
        this.host.setBooting(false);
        this.persist();
      }
    }
    return this.host.isCurrent(operation) && restore.userClosedTab;
  }

  markExited(tab: TerminalPanelSessionTab, sessionId: string): void {
    tab.gatewaySessionId = sessionId;
    this.host.exited(tab);
  }

  retireTab(tab: TerminalPanelSessionTab): void {
    const restore = this.batch;
    if (restore && this.host.isCurrent(restore.operation, restore)) {
      for (const [sessionId, pendingTab] of restore.pending) {
        if (pendingTab === tab) {
          this.unresolvedSessionIds.delete(sessionId);
          restore.userClosedTab ||= tab.cancelled === "close";
          restore.pending.delete(sessionId);
          if (tab.cancelled === "close" && restore.pending.size === 0) {
            restore.cancelIntent?.();
          }
          break;
        }
      }
    }
  }

  persist(): void {
    const restore = this.batch;
    if (restore && !this.host.isCurrent(restore.operation, restore)) {
      return;
    }
    const ids = new Set([
      ...this.host
        .tabs()
        .filter((tab) => tab.status === "live" && tab.gatewaySessionId)
        .map((tab) => tab.gatewaySessionId),
      ...this.unresolvedSessionIds,
    ]);
    for (const sessionId of restore?.pending.keys() ?? []) {
      ids.add(sessionId);
    }
    persistTerminalSessionIds([...ids], this.host.storageScope());
  }
}
