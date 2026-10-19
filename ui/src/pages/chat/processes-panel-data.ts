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
  "rows" | "loading" | "hasResult" | "truncated" | "error" | "stopping"
>;
const EMPTY_PROCESSES: ProcessSnapshot = {
  rows: [],
  loading: false,
  hasResult: false,
  truncated: false,
  error: null,
  stopping: new Set(),
};
type SharedObservation = { data: ProcessObservation; listeners: Set<() => void> };
const observations = new WeakMap<ApplicationContext["sessions"], Map<string, SharedObservation>>();

/** Visible presentations of the same session share its snapshot, read and timer. */
export class ProcessesPanelData {
  private readonly entries: Map<string, SharedObservation>;
  private entry: SharedObservation | null = null;
  private key: string | null = null;

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
    return this.entry?.data.refresh() ?? Promise.resolve();
  }

  stop(row: SessionProcessSummary): Promise<void> {
    return this.entry?.data.stop(row) ?? Promise.resolve();
  }

  dispose(): void {
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
  error: string | null = null;
  readonly stopping = new Set<string>();
  private sessionId: string | null = null;
  private scope: SessionConnectionScope | null = null;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private refreshAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;
  private readonly stopVisibility: (() => void) | undefined;

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
        this.error ||
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

  refresh(): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const scope = this.scope;
    if (!scope || !this.current(this.generation)) {
      return Promise.resolve();
    }
    const generation = this.generation;
    this.refreshAgain = false;
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
        // A change arriving during the read needs one trailing snapshot. Otherwise
        // retain only a slow recovery poll; errors require explicit Retry.
        if (!this.error) {
          if (this.refreshAgain) {
            void this.refresh();
          } else {
            this.timer = setTimeout(() => void this.refresh(), REFRESH_INTERVAL_MS);
          }
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
    this.refreshAgain = false;
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
    this.unsubscribeEvents();
    this.stopVisibility?.();
  }
}
