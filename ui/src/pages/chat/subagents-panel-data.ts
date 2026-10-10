import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SidebarSessionNarrationController } from "../../components/app-sidebar-session-narration.ts";
import type { SidebarToolActivity } from "../../components/app-sidebar-session-types.ts";
import { readSidebarToolActivity } from "../../components/sidebar-tool-activity.ts";
import { resolveToolDisplay } from "../../lib/chat/tool-display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { childSessionListQuery } from "../../lib/sessions/child-session-data.ts";
import type {
  SessionCapability,
  SessionListSnapshot,
  SessionMessageSubscription,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiConversationIdentity,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import { parseSessionChangedEvent } from "../../lib/sessions/session-row-reconcile.ts";
import { requestChatAbort } from "./chat-abort-request.ts";
import { requestSharedHistory } from "./chat-history-request.ts";
import { historySessionId, isHistoryCursor } from "./chat-history-snapshot.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { isSubagentsPanelSession } from "./chat-spawned-subagent.ts";
import {
  readSubagentActivitySnapshot,
  readSubagentToolEvent,
  subagentToolCallCount,
  type SubagentActivitySnapshot,
} from "./subagents-panel-activity.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

const PAGE_SIZE = 20;
const HISTORY_CONCURRENCY = 2;
const MAX_RETAINED_CALLS = 1024;

export type SubagentsPanelRow = {
  session: GatewaySessionRow;
  callCount?: number;
  activity?: string;
  toolDisplayName?: string;
  canStop: boolean;
  stopping: boolean;
  stopAccess: SessionMethodAccess;
};

export type SubagentsPanelInput = {
  sessionKey: string;
  agentId: string;
  presented: boolean;
};

type Metrics = SubagentActivitySnapshot & {
  identity: string;
  pending: boolean;
  read: boolean;
  liveToolObserved: boolean;
  preparedCalls: Set<string>;
  unidentifiedCall: boolean;
};

function runIdentity(row: GatewaySessionRow): string {
  return JSON.stringify([row.sessionId, row.lastRunId, row.activeRunIds, row.status]);
}

function createMetrics(identity: string): Metrics {
  return {
    identity,
    calls: new Map(),
    complete: false,
    pending: false,
    read: false,
    liveToolObserved: false,
    preparedCalls: new Set(),
    unidentifiedCall: false,
  };
}

/** Presentation-scoped child discovery. Shared owners retain wire subscriptions and roster facts. */
export class SubagentsPanelData {
  rows: readonly SubagentsPanelRow[] = [];
  loading = false;
  error: string | null = null;
  hasMore = false;
  hasResult = false;

  private input: SubagentsPanelInput | null = null;
  private scope: ReturnType<SessionCapability["captureConnectionScope"]> = null;
  private observation: ReturnType<SessionCapability["observeList"]> | null = null;
  private pendingListRead: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private nextOffset: number | null = null;
  private sessions: GatewaySessionRow[] = [];
  private metrics = new Map<string, Metrics>();
  private historyReads = 0;
  private tools: ReadonlyMap<string, SidebarToolActivity> = new Map();
  private stopping = new Set<string>();
  private readonly messageSubscriptions = new Map<string, Set<SessionMessageSubscription>>();
  private readonly narrationSource: Pick<
    SessionCapability,
    "subscribeMessages" | "unsubscribeMessages"
  >;
  private readonly narration: SidebarSessionNarrationController;
  private readonly unsubscribe: Array<() => void>;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();

  constructor(
    private readonly context: ApplicationContext,
    private readonly changed: () => void,
  ) {
    this.narrationSource = {
      subscribeMessages: async (key, options) => {
        const generation = this.generation;
        const subscription = await context.sessions.subscribeMessages(key, options);
        if (this.current(generation)) {
          const subscriptions = this.messageSubscriptions.get(key) ?? new Set();
          subscriptions.add(subscription);
          this.messageSubscriptions.set(key, subscriptions);
          this.readMetrics();
        }
        return subscription;
      },
      unsubscribeMessages: async (subscription) => {
        await context.sessions.unsubscribeMessages(subscription);
        for (const [key, subscriptions] of this.messageSubscriptions) {
          subscriptions.delete(subscription);
          if (subscriptions.size === 0) {
            this.messageSubscriptions.delete(key);
          }
        }
      },
    };
    this.narration = new SidebarSessionNarrationController(
      () => undefined,
      () => undefined,
      (tools) => {
        this.tools = tools;
        this.publish();
      },
    );
    this.unsubscribe = [
      context.gateway.subscribe(() => {
        this.reconcile();
        this.publish();
      }),
      context.gateway.subscribeEvents((event) => this.handleEvent(event)),
    ];
    this.visibilityDocument?.addEventListener("visibilitychange", this.visibilityChanged);
  }

  sync(input: SubagentsPanelInput): void {
    const changed =
      input.sessionKey !== this.input?.sessionKey ||
      normalizeAgentId(input.agentId) !== normalizeAgentId(this.input?.agentId);
    if (!changed && input.presented === this.input?.presented) {
      return;
    }
    this.input = input;
    if (changed) {
      this.retire();
    }
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
      this.publish();
      return;
    }
    if (this.scope && !this.context.sessions.isConnectionScopeCurrent(this.scope)) {
      this.retire();
    }
    if (this.observation) {
      return;
    }
    this.scope = scope;
    const generation = this.generation;
    this.loading = true;
    this.error = null;
    this.observation = this.context.sessions.observeList(
      this.childQuery(this.input),
      (snapshot) => {
        if (this.current(generation)) {
          this.applyList(snapshot);
        }
      },
    );
    void this.refresh();
  }

  private childQuery(input: SubagentsPanelInput) {
    const parent = resolveUiConversationIdentity(
      {
        assistantAgentId: input.agentId,
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      },
      input.sessionKey,
      input.agentId,
    );
    return {
      ...childSessionListQuery(parent.sessionKey, PAGE_SIZE),
      // Global aliases require their physical agent scope. Canonical parents
      // must retain children spawned on other configured agents.
      ...(parent.sessionKey === "global" ? { agentId: parent.agentId } : {}),
    };
  }

  async refresh(): Promise<void> {
    const observation = this.observation;
    if (!observation) {
      return;
    }
    await this.readList(() => {
      this.metrics.clear();
      this.error = null;
      return observation.refresh();
    });
  }

  async loadMore(): Promise<void> {
    if (!this.input || this.loading || !this.hasMore || this.nextOffset === null) {
      return;
    }
    await this.readList(() => {
      if (!this.input || this.loading || !this.hasMore || this.nextOffset === null) {
        return Promise.resolve();
      }
      return this.context.sessions.refreshList({
        ...this.childQuery(this.input),
        offset: this.nextOffset,
        append: true,
      });
    });
  }

  private async readList(read: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    // The roster publishes ready rows before releasing its pending RPC. Join
    // our prior operation so a click from that publication cannot lose an append.
    while (this.pendingListRead && this.current(generation)) {
      await this.pendingListRead.catch(() => undefined);
    }
    if (!this.current(generation)) {
      return;
    }
    const pending = Promise.resolve().then(() => (this.current(generation) ? read() : undefined));
    this.pendingListRead = pending;
    try {
      await pending;
    } catch (error) {
      if (this.current(generation)) {
        this.error = formatUiError(error);
        this.publish();
      }
    } finally {
      if (this.pendingListRead === pending) {
        this.pendingListRead = null;
      }
    }
  }

  private applyList(snapshot: SessionListSnapshot): void {
    this.loading = snapshot.loading;
    this.error = snapshot.error;
    const result = snapshot.result;
    if (snapshot.error) {
      // Access loss must not leave previously readable child contents onscreen.
      this.sessions = [];
      this.metrics.clear();
      this.hasMore = false;
      this.nextOffset = null;
    } else if (result) {
      this.hasResult = true;
      this.hasMore = result.hasMore === true;
      this.nextOffset = result.nextOffset ?? null;
      const sampledAt = Date.now();
      const previous = new Map(this.sessions.map((row) => [row.key, row]));
      this.sessions = result.sessions.filter(isSubagentsPanelSession).map((row) => {
        const held = previous.get(row.key);
        const sameSample =
          held && runIdentity(held) === runIdentity(row) && held.runtimeMs === row.runtimeMs;
        return Object.assign({}, row, {
          agentId: resolveUiSessionRowAgentId(row, this.input?.agentId ?? "main"),
          runtimeSampledAt:
            row.runtimeSampledAt ?? (sameSample ? held.runtimeSampledAt : undefined) ?? sampledAt,
        });
      });
      const keys = new Set(this.sessions.map((row) => row.key));
      for (const key of this.metrics.keys()) {
        if (!keys.has(key)) {
          this.metrics.delete(key);
        }
      }
      for (const row of this.sessions) {
        const identity = runIdentity(row);
        if (this.metrics.get(row.key)?.identity !== identity) {
          this.metrics.set(row.key, createMetrics(identity));
        }
      }
    }
    this.syncNarration();
    this.publish();
    this.readMetrics();
  }

  private syncNarration(): void {
    this.narration.sync({
      enabled: Boolean(this.input?.presented && this.scope),
      connected: Boolean(this.context.sessions.captureConnectionScope()),
      connectionIdentity: this.context.gateway.snapshot.hello,
      source: this.narrationSource,
      rows: this.sessions.map((row) => ({
        key: row.key,
        hasActiveRun: isSessionRunActive(row),
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
      })),
      openSessionKey: this.input?.sessionKey ?? "",
      agentId: this.input?.agentId ?? "main",
    });
  }

  private readMetrics(): void {
    if (!this.scope || !this.current(this.generation)) {
      return;
    }
    for (const row of this.sessions) {
      const metrics = this.metrics.get(row.key);
      if (
        !metrics ||
        metrics.read ||
        metrics.pending ||
        this.historyReads >= HISTORY_CONCURRENCY ||
        (isSessionRunActive(row) && !this.messageSubscriptions.has(row.key))
      ) {
        continue;
      }
      metrics.pending = true;
      this.historyReads += 1;
      const generation = this.generation;
      const scope = this.scope;
      const current = () => this.current(generation) && this.metrics.get(row.key) === metrics;
      const requestKey = `subagent-panel\u0000${row.key}\u0000${row.sessionId ?? ""}`;
      void requestSharedHistory(
        null,
        scope.client,
        requestKey,
        "chat.history",
        row.key,
        row.agentId,
        this,
        { isCurrent: current },
      )
        .then((history) => {
          if (
            !current() ||
            isHistoryCursor(history) ||
            !row.sessionId ||
            historySessionId(history) !== row.sessionId
          ) {
            return;
          }
          const snapshot = readSubagentActivitySnapshot(history);
          for (const [id, item] of metrics.calls) {
            if (snapshot.calls.get(id)?.phase !== "end" || item.phase === "end") {
              const prepared = metrics.preparedCalls.has(id);
              const update = readSubagentToolEvent(
                prepared ? "item" : "tool",
                prepared ? item : { ...item, phase: item.phase === "end" ? "result" : item.phase },
                snapshot.calls.get(id),
              );
              if (update) {
                snapshot.calls.set(id, update);
              }
            }
          }
          if (snapshot.calls.size > MAX_RETAINED_CALLS) {
            snapshot.calls.clear();
            metrics.preparedCalls.clear();
            snapshot.complete = false;
          }
          metrics.calls = snapshot.calls;
          metrics.complete = snapshot.complete && !metrics.unidentifiedCall;
          metrics.tool = snapshot.tool;
        })
        .catch(() => {
          // Counts are optional. Explicit refresh retries unavailable history.
        })
        .finally(() => {
          this.historyReads -= 1;
          if (current()) {
            metrics.pending = false;
            metrics.read = true;
            this.publish();
          }
          this.readMetrics();
        });
    }
  }

  private handleEvent(event: GatewayEventFrame): void {
    if (!this.current(this.generation)) {
      return;
    }
    if (event.event === "sessions.changed") {
      const info = parseSessionChangedEvent(event.payload)?.[0];
      if (info && ["reset", "rewind", "branch-switch", "compact"].includes(info.reason ?? "")) {
        const row = this.sessions.find((candidate) =>
          areUiSessionKeysEquivalent(candidate.key, info.key),
        );
        if (row) {
          this.metrics.set(row.key, createMetrics(runIdentity(row)));
          this.publish();
          this.readMetrics();
        }
      }
      return;
    }
    if (event.event !== "agent" && event.event !== "session.tool") {
      return;
    }
    const payload = asOptionalRecord(event.payload);
    const stream = payload?.stream;
    if (stream !== "tool" && stream !== "item" && stream !== "lifecycle") {
      return;
    }
    if (stream === "item" && asOptionalRecord(payload?.data)?.kind !== "tool") {
      return;
    }
    if (typeof payload?.sessionKey !== "string" || typeof payload.runId !== "string") {
      return;
    }
    const sessionKey = payload.sessionKey;
    const runId = payload.runId;
    const row = this.sessions.find(
      (candidate) =>
        areUiSessionKeysEquivalent(candidate.key, sessionKey) &&
        candidate.activeRunIds?.includes(runId) &&
        (typeof payload.agentId !== "string" ||
          normalizeAgentId(payload.agentId) === candidate.agentId),
    );
    if (!row) {
      return;
    }
    if (stream === "lifecycle") {
      this.narration.handleEvent(event);
      return;
    }
    const metrics = this.metrics.get(row.key);
    if (!metrics) {
      return;
    }
    const fallback = !metrics.liveToolObserved && metrics.tool && !this.tools.has(row.key);
    const activity = readSidebarToolActivity(stream, payload.data, metrics.tool);
    if (activity !== undefined) {
      metrics.liveToolObserved = true;
    }
    this.narration.handleEvent(event);
    const data = asOptionalRecord(payload.data);
    const callId = data?.toolCallId;
    const callIdentity =
      typeof callId === "string" ? buildToolStreamIdentity(runId, callId) : undefined;
    const item = readSubagentToolEvent(
      payload.stream,
      payload.data,
      callIdentity ? metrics.calls.get(callIdentity) : undefined,
    );
    if (!item) {
      if (fallback && activity !== undefined && !this.tools.has(row.key)) {
        this.publish();
      }
      return;
    }
    metrics.liveToolObserved = true;
    if (!item.toolCallId?.trim()) {
      // An item identity is not an invocation identity. A later promoted frame
      // cannot prove whether it aliases a previously observed call.
      metrics.unidentifiedCall = true;
      metrics.complete = false;
      this.publish();
      return;
    }
    const id = buildToolStreamIdentity(runId, item.toolCallId);
    if (metrics.calls.size >= MAX_RETAINED_CALLS && !metrics.calls.has(id)) {
      metrics.complete = false;
    } else {
      if (payload.stream === "item") {
        metrics.preparedCalls.add(id);
      }
      metrics.calls.set(id, item);
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) {
      return;
    }
    this.rows = this.sessions.map((session) => {
      const metrics = this.metrics.get(session.key);
      const tool = isSessionRunActive(session)
        ? (this.tools.get(session.key) ?? (metrics?.liveToolObserved ? undefined : metrics?.tool))
        : undefined;
      const stopAccess = readChatSessionActionAccess(this.context.gateway.snapshot, true, {
        session,
        sessionAbortable: true,
      }).abort;
      return {
        session,
        callCount: metrics ? subagentToolCallCount(metrics) : undefined,
        activity: tool?.text,
        toolDisplayName: tool ? resolveToolDisplay({ name: tool.name }).label : undefined,
        canStop:
          isSessionRunActive(session) && session.activeRunIds?.length === 1 && stopAccess.allowed,
        stopping: this.stopping.has(session.key),
        stopAccess,
      };
    });
    this.changed();
  }

  async stop(row: SubagentsPanelRow): Promise<void> {
    const session = this.sessions.find(
      (candidate) =>
        candidate.key === row.session.key && candidate.sessionId === row.session.sessionId,
    );
    const runId = row.session.activeRunIds?.length === 1 ? row.session.activeRunIds[0] : undefined;
    const scope = this.scope;
    if (
      !session ||
      !runId ||
      !session.activeRunIds?.includes(runId) ||
      !scope ||
      !this.current(this.generation) ||
      this.stopping.has(session.key)
    ) {
      return;
    }
    const access = readChatSessionActionAccess(this.context.gateway.snapshot, true, {
      session,
      sessionAbortable: true,
    }).abort;
    if (!access.allowed) {
      this.error = access.reason;
      this.publish();
      return;
    }
    const generation = this.generation;
    this.stopping.add(session.key);
    this.publish();
    const result = await requestChatAbort(scope.client, {
      sessionKey: session.key,
      agentId: session.agentId,
      runId,
      sessionAbortable: true,
    });
    if (!this.current(generation)) {
      return;
    }
    this.stopping.delete(session.key);
    this.error = result.ok ? (result.warning ?? null) : formatUiError(result.error);
    this.publish();
    if (result.ok) {
      void this.refresh();
    }
  }

  private current(generation: number): boolean {
    return Boolean(
      !this.disposed &&
      generation === this.generation &&
      this.scope &&
      this.context.sessions.isConnectionScopeCurrent(this.scope),
    );
  }

  private retire(): void {
    this.generation += 1;
    this.observation?.dispose();
    this.observation = null;
    this.pendingListRead = null;
    this.scope = null;
    this.sessions = [];
    this.metrics.clear();
    this.tools = new Map();
    this.stopping.clear();
    this.messageSubscriptions.clear();
    this.loading = false;
    this.hasMore = false;
    this.hasResult = false;
    this.nextOffset = null;
    this.error = null;
    this.syncNarration();
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.narration.dispose();
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }
    this.visibilityDocument?.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
