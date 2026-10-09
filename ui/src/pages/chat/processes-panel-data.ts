import type {
  SessionProcessSummary,
  SessionsProcessesListResult,
  SessionsProcessesStopResult,
} from "../../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerProcessesEnglish } from "../../i18n/locales/en-processes.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionConnectionScope } from "../../lib/sessions/session-capability.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";

registerProcessesEnglish();

const REFRESH_INTERVAL_MS = 5_000;
type ProcessesPanelInput = { sessionKey: string; agentId: string; presented: boolean };

/** A visible panel observes the process owner without draining agent output. */
export class ProcessesPanelData {
  rows: readonly SessionProcessSummary[] = [];
  loading = false;
  hasResult = false;
  truncated = false;
  error: string | null = null;
  readonly stopping = new Set<string>();
  private sessionId: string | null = null;
  private input: ProcessesPanelInput | null = null;
  private scope: SessionConnectionScope | null = null;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly context: ApplicationContext,
    private readonly changed: () => void,
  ) {
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.visibilityDocument?.addEventListener("visibilitychange", this.visibilityChanged);
  }

  sync(input: ProcessesPanelInput): void {
    if (input.sessionKey !== this.input?.sessionKey || input.agentId !== this.input?.agentId) {
      this.retire();
    }
    this.input = input;
    this.reconcile();
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const visible = this.input?.presented && this.visibilityDocument?.visibilityState !== "hidden";
    const scope = visible ? this.context.sessions.captureConnectionScope() : null;
    if (!scope || !this.input?.sessionKey) {
      this.retire();
      this.changed();
      return;
    }
    if (this.scope && !this.context.sessions.isConnectionScopeCurrent(this.scope)) {
      this.retire();
    }
    if (!this.scope) {
      this.scope = scope;
      void this.refresh();
    }
  }

  private target() {
    const identity = resolveUiConversationIdentity(
      {
        assistantAgentId: this.input!.agentId,
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      },
      this.input!.sessionKey,
      this.input!.agentId,
    );
    return { key: identity.sessionKey, agentId: identity.agentId };
  }

  refresh(): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const scope = this.scope;
    if (!scope || !this.input || !this.current(this.generation)) {
      return Promise.resolve();
    }
    const generation = this.generation;
    this.clearTimer();
    this.loading = true;
    this.error = null;
    this.changed();
    const pending = scope.client
      .request<SessionsProcessesListResult>("sessions.processes.list", this.target())
      .then((result) => {
        if (!this.current(generation)) {
          return;
        }
        this.sessionId = result.sessionId;
        this.rows = result.processes;
        this.truncated = result.truncated;
        this.hasResult = true;
        for (const id of this.stopping) {
          if (!this.rows.some((row) => row.instanceId === id && row.status === "running")) {
            this.stopping.delete(id);
          }
        }
      })
      .catch((error: unknown) => {
        if (!this.current(generation)) {
          return;
        }
        // Access loss cannot leave the previous private output visible.
        this.rows = [];
        this.sessionId = null;
        this.stopping.clear();
        this.error = formatUiError(error);
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = null;
        }
        if (!this.current(generation)) {
          return;
        }
        this.loading = false;
        this.changed();
        // The process registry has no subscription feed. Refresh only this visible
        // presentation; errors require explicit Retry rather than a request storm.
        if (!this.error) {
          this.timer = setTimeout(() => void this.refresh(), REFRESH_INTERVAL_MS);
        }
      });
    this.pending = pending;
    return pending;
  }

  async stop(row: SessionProcessSummary): Promise<void> {
    const scope = this.scope;
    const sessionId = this.sessionId;
    const generation = this.generation;
    const current = this.rows.find(
      (item) => item.processId === row.processId && item.instanceId === row.instanceId,
    );
    if (
      !scope ||
      !sessionId ||
      !this.current(generation) ||
      !current?.canStop ||
      this.stopping.has(row.instanceId)
    ) {
      return;
    }
    this.clearTimer();
    this.stopping.add(row.instanceId);
    this.error = null;
    this.changed();
    try {
      const result = await scope.client.request<SessionsProcessesStopResult>(
        "sessions.processes.stop",
        {
          ...this.target(),
          sessionId,
          processId: row.processId,
          instanceId: row.instanceId,
        },
      );
      if (!this.current(generation)) {
        return;
      }
      if (!result.requested) {
        this.stopping.delete(row.instanceId);
        this.error = t("chat.processesPanel.stopNotRequested");
        this.changed();
        return;
      }
      // Join a prior snapshot before observing the stop; a stale read must not
      // be mistaken for its acknowledgment. The owner reports actual exit later.
      await this.pending;
      if (this.current(generation)) {
        await this.refresh();
      }
    } catch (error) {
      if (!this.current(generation)) {
        return;
      }
      this.stopping.delete(row.instanceId);
      this.error = formatUiError(error);
      this.changed();
    }
  }

  private current(generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      Boolean(this.scope && this.context.sessions.isConnectionScopeCurrent(this.scope))
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  private retire(): void {
    this.generation += 1;
    this.clearTimer();
    this.scope = null;
    this.pending = null;
    this.rows = [];
    this.sessionId = null;
    this.stopping.clear();
    this.loading = false;
    this.hasResult = false;
    this.truncated = false;
    this.error = null;
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.visibilityDocument?.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
