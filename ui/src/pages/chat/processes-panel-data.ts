import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionProcessSummary,
  SessionsProcessesListResult,
  SessionsProcessesStopResult,
} from "../../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerProcessesEnglish } from "../../i18n/locales/en-processes.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { SessionConnectionScope } from "../../lib/sessions/session-capability.ts";
import {
  resolveUiConversationIdentity,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";

registerProcessesEnglish();

const REFRESH_INTERVAL_MS = 60_000;
type ProcessesPanelInput = { sessionKey: string; agentId: string; presented: boolean };
type ProcessSnapshot = Pick<
  ProcessObservation,
  "rows" | "loading" | "hasResult" | "truncated" | "error" | "readError" | "errorKind" | "stopping"
>;
const EMPTY_PROCESSES: ProcessSnapshot = {
  rows: [],
  loading: false,
  hasResult: false,
  truncated: false,
  error: null,
  readError: null,
  errorKind: null,
  stopping: new Set(),
};
type SharedObservation = { data: ProcessObservation; listeners: Set<() => void> };
const observations = new WeakMap<ApplicationContext["sessions"], Map<string, SharedObservation>>();

/** Visible presentations of the same session share its snapshot, read and timer. */
export class ProcessesPanelData {
  private readonly entries: Map<string, SharedObservation>;
  private entry: SharedObservation | null = null;
  private key: string | null = null;
  private lifetime = Promise.withResolvers<void>();

  constructor(
    private readonly context: ApplicationContext,
    private readonly changed: () => void,
  ) {
    let entries = observations.get(context.sessions);
    if (!entries) {
      entries = new Map();
      observations.set(context.sessions, entries);
    }
    this.entries = entries;
  }

  get snapshot(): ProcessSnapshot {
    return this.entry?.data ?? EMPTY_PROCESSES;
  }

  get pendingRead(): Promise<void> | null {
    return this.entry?.data.pendingRead ?? null;
  }

  get retired(): Promise<void> {
    return this.lifetime.promise;
  }

  get connectionRetired(): Promise<void> | undefined {
    return this.entry?.data.retired;
  }

  sync(input: ProcessesPanelInput): void {
    const key =
      input.presented && input.sessionKey
        ? JSON.stringify([input.agentId, input.sessionKey])
        : null;
    if (key === this.key) {
      return;
    }
    this.dispose();
    if (key !== null) {
      let entry = this.entries.get(key);
      if (!entry) {
        const listeners = new Set<() => void>();
        entry = {
          data: new ProcessObservation(this.context, input, () => {
            listeners.forEach((listener) => listener());
          }),
          listeners,
        };
        this.entries.set(key, entry);
      }
      this.key = key;
      this.entry = entry;
      entry.listeners.add(this.changed);
    }
    this.changed();
  }

  refresh(): Promise<void> {
    return this.entry?.data.refresh(true) ?? Promise.resolve();
  }

  stop(row: SessionProcessSummary): Promise<void> {
    return this.entry?.data.stop(row) ?? Promise.resolve();
  }

  reportStopError(row: SessionProcessSummary, error: unknown): void {
    this.entry?.data.reportStopError(row, error);
  }

  dispose(): void {
    // A closed presentation retires independently of other shared consumers.
    this.lifetime.resolve();
    this.lifetime = Promise.withResolvers<void>();
    if (this.entry) {
      this.entry.listeners.delete(this.changed);
      if (this.entry.listeners.size === 0) {
        this.entry.data.dispose();
        this.entries.delete(this.key!);
      }
    }
    this.entry = null;
    this.key = null;
  }
}

/** Observes the process owner without draining agent output. */
class ProcessObservation {
  rows: readonly SessionProcessSummary[] = [];
  loading = false;
  hasResult = false;
  truncated = false;
  readError: string | null = null;
  private readDenied = false;
  private actionError: string | null = null;
  private actionInstanceId: string | null = null;
  get error(): string | null {
    return this.readDenied ? this.readError : (this.actionError ?? this.readError);
  }
  get errorKind(): "read" | "access" | "action" | null {
    return this.readDenied
      ? "access"
      : this.actionError
        ? "action"
        : this.readError
          ? "read"
          : null;
  }
  readonly stopping = new Set<string>();
  private sessionId: string | null = null;
  private scope: SessionConnectionScope | null = null;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private lifetime = Promise.withResolvers<void>();
  private refreshAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;
  private readonly stopVisibility: (() => void) | undefined;

  get pendingRead(): Promise<void> | null {
    return this.pending;
  }

  get retired(): Promise<void> | undefined {
    return this.scope ? this.lifetime.promise : undefined;
  }

  constructor(
    private readonly context: ApplicationContext,
    private readonly input: ProcessesPanelInput,
    private readonly changed: () => void,
  ) {
    // Connection edges retire observation scopes synchronously, including while hidden.
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.unsubscribeEvents = context.gateway.subscribeEvents(({ event, payload }) => {
      if (!isRecord(payload)) {
        return;
      }
      const sessionChanged =
        event === "sessions.changed" &&
        ["delete", "reset", "sharing", "profile-identity", "placement"].includes(
          String(payload.reason),
        );
      if (
        (event !== "sessions.processes.changed" && !sessionChanged) ||
        (typeof payload.sessionKey !== "string" &&
          !(sessionChanged && payload.sessionKey === undefined)) ||
        (payload.agentId !== undefined && typeof payload.agentId !== "string") ||
        !this.current(this.generation) ||
        (typeof payload.sessionKey === "string" &&
          !uiConversationMatches(
            {
              assistantAgentId: this.input.agentId,
              agentsList: context.agents.state.agentsList,
              hello: context.gateway.snapshot.hello,
            },
            this.input.sessionKey,
            payload.sessionKey,
            payload.agentId,
            this.input.agentId,
          ))
      ) {
        return;
      }
      if (this.pending) {
        this.refreshAgain = true;
      } else {
        void this.refresh();
      }
    });
    this.stopVisibility = this.visibilityDocument
      ? listen(this.visibilityDocument, "visibilitychange", this.visibilityChanged)
      : undefined;
    this.reconcile();
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const visible = this.visibilityDocument?.visibilityState !== "hidden";
    const scope = visible ? this.context.sessions.captureConnectionScope() : null;
    if (!scope) {
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
        assistantAgentId: this.input.agentId,
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      },
      this.input.sessionKey,
      this.input.agentId,
    );
    return { key: identity.sessionKey, agentId: identity.agentId };
  }

  refresh(explicit = false): Promise<void> {
    if (explicit) {
      this.actionError = null;
      this.actionInstanceId = null;
      this.changed();
    }
    if (this.pending) {
      return this.pending;
    }
    const scope = this.scope;
    if (!scope || !this.current(this.generation)) {
      return Promise.resolve();
    }
    const generation = this.generation;
    let accessDenied = false;
    this.refreshAgain = false;
    this.clearTimer();
    this.loading = true;
    const pending = scope.client
      .request<SessionsProcessesListResult>("sessions.processes.list", this.target())
      .then((result) => {
        if (!this.current(generation)) {
          return;
        }
        this.readError = null;
        this.readDenied = false;
        this.sessionId = result.sessionId;
        this.rows = result.processes;
        this.truncated = result.truncated;
        this.hasResult = true;
        const actionRow = this.rows.find((row) => row.instanceId === this.actionInstanceId);
        if (this.actionError && (actionRow ? actionRow.status !== "running" : !result.truncated)) {
          this.actionError = null;
          this.actionInstanceId = null;
        }
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
        accessDenied =
          error instanceof GatewayProtocolRequestError && error.gatewayCode === "FORBIDDEN";
        if (accessDenied) {
          this.rows = [];
          this.sessionId = null;
          this.actionError = null;
          this.actionInstanceId = null;
          this.stopping.clear();
          this.hasResult = false;
          this.truncated = false;
        }
        this.readError = formatUiError(error);
        this.readDenied = accessDenied;
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
        // A change arriving during the read needs one trailing snapshot. Otherwise
        // retain one slow recovery poll, including after transient read failures.
        if (!accessDenied) {
          if (this.refreshAgain) {
            void this.refresh();
          } else {
            this.timer = setTimeout(() => void this.refresh(), REFRESH_INTERVAL_MS);
          }
        }
      });
    this.pending = pending;
    this.changed();
    return pending;
  }

  reportStopError(row: SessionProcessSummary, error: unknown): void {
    this.actionError = formatUiError(error);
    this.actionInstanceId = row.instanceId;
    this.changed();
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
    this.stopping.add(row.instanceId);
    this.actionError = null;
    this.actionInstanceId = null;
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
        this.actionError = t("chat.processesPanel.stopNotRequested");
        this.actionInstanceId = row.instanceId;
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
      this.actionError = formatUiError(error);
      this.actionInstanceId = row.instanceId;
      const denied =
        error instanceof GatewayProtocolRequestError && error.gatewayCode === "FORBIDDEN";
      if (denied) {
        this.rows = this.rows.map((item) => ({ ...item, canStop: false }));
      }
      this.changed();
      if (denied) {
        // A denied write does not prove read access was revoked. Reconcile the
        // current output and Stop authority without repeating the mutation.
        await this.pending;
        if (this.current(generation)) {
          await this.refresh();
        }
      }
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
    this.lifetime.resolve();
    this.lifetime = Promise.withResolvers<void>();
    this.generation += 1;
    this.clearTimer();
    this.scope = null;
    this.pending = null;
    this.refreshAgain = false;
    this.rows = [];
    this.sessionId = null;
    this.stopping.clear();
    this.loading = false;
    this.hasResult = false;
    this.truncated = false;
    this.readError = null;
    this.readDenied = false;
    this.actionError = null;
    this.actionInstanceId = null;
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.unsubscribeEvents();
    this.stopVisibility?.();
  }
}
