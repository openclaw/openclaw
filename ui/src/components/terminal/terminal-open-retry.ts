import {
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";
import type {
  TerminalPanelAction,
  TerminalPanelCatalogReference,
} from "./terminal-panel-session-types.ts";

type RetryOpenAction = Extract<TerminalPanelAction, { kind: "catalog" | "open" }>;

/** Retains the exact failed open intent until the operator retries or the tab becomes ready. */
export class TerminalOpenRetry {
  private action: RetryOpenAction | null = null;

  constructor(private readonly queue: (action: RetryOpenAction) => Promise<void>) {}

  remember(catalog: TerminalPanelCatalogReference | undefined, agentId: string | null): void {
    this.action = catalog ? { kind: "catalog", agentId, catalog } : { kind: "open", agentId };
  }

  clearUnlessRetryable(error: unknown): void {
    if (
      !(
        error instanceof TerminalOpenTimeoutError ||
        error instanceof TerminalOpenUnusableSessionError
      )
    ) {
      this.clear();
    }
  }

  clear(): void {
    this.action = null;
  }

  get available(): boolean {
    return this.action !== null;
  }

  run(): void {
    const action = this.action;
    this.clear();
    if (action) {
      void this.queue(action);
    }
  }
}
