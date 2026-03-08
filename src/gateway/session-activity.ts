import {
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  type SubagentRunRecord,
} from "../agents/subagent-registry.js";
import type { AgentEventPayload } from "../infra/agent-events.js";

const DEFAULT_STALE_RUN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RECENT_CHILDREN_LIMIT = 8;

const AWAITING_USER_TOOL_NAMES = new Set([
  "request_user_input",
  "request-user-input",
  "requestuserinput",
]);

export const SESSION_ACTIVITY_STATECHANGE_EVENT = "sessions.activity.statechange";

export type SessionActivityAttentionState =
  | "none"
  | "awaiting_user"
  | "awaiting_subagent"
  | "awaiting_approval"
  | "blocked"
  | "paused";

export type SessionActivityBlockedOn = {
  kind: string;
  childSessionKey?: string;
  childRunId?: string;
  label?: string;
  startedAt?: number;
  approvalId?: string;
};

export type SessionRuntimeActivity = {
  busy: boolean;
  activeRuns: number;
  busySince: number | null;
  lastRunActivityAt: number | null;
  staleRuns: number;
};

export type SessionAttentionActivity = {
  state: SessionActivityAttentionState;
  since: number | null;
  note?: string;
  blockedOn?: SessionActivityBlockedOn[];
};

export type SessionChildrenRecent = {
  childSessionKey: string;
  status: string;
  childRunId?: string;
  label?: string;
  startedAt?: number;
};

export type SessionChildrenRollup = {
  total: number;
  active: number;
  failed: number;
  recent: SessionChildrenRecent[];
};

export type SessionActivitySnapshot = {
  sessionKey: string;
  version: number;
  runtimeActivity: SessionRuntimeActivity;
  attention: SessionAttentionActivity;
  children: SessionChildrenRollup;
};

type ActiveRunEntry = {
  sessionKey: string;
  startedAt: number;
  lastActivityAt: number;
};

type PendingApprovalEntry = {
  id: string;
  sessionKey: string;
  createdAtMs: number;
  expiresAtMs: number;
};

type AwaitingUserRunEntry = {
  runId: string;
  sessionKey: string;
  since: number;
};

type SessionTrackerState = {
  version: number;
  activeRunIds: Set<string>;
  pendingApprovalIds: Set<string>;
  awaitingUserRunIds: Set<string>;
  lastRunActivityAt: number | null;
  staleRuns: number;
  signature: string;
};

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function isAwaitingUserToolName(name: string): boolean {
  return AWAITING_USER_TOOL_NAMES.has(name);
}

function buildBlockedOnSubagents(entries: SubagentRunRecord[]): SessionActivityBlockedOn[] {
  return entries.map((entry) => ({
    kind: "subagent",
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    label: entry.label,
    startedAt:
      typeof entry.startedAt === "number"
        ? entry.startedAt
        : typeof entry.createdAt === "number"
          ? entry.createdAt
          : undefined,
  }));
}

function deriveChildStatus(entry: SubagentRunRecord): string {
  if (typeof entry.endedAt !== "number") {
    return "running";
  }
  const status = entry.outcome?.status;
  if (
    status === "ok" ||
    status === "error" ||
    status === "timeout" ||
    status === "unknown" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "done";
}

export class SessionActivityTracker {
  private readonly states = new Map<string, SessionTrackerState>();
  private readonly activeRuns = new Map<string, ActiveRunEntry>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly awaitingUserRuns = new Map<string, AwaitingUserRunEntry>();
  private readonly now: () => number;
  private readonly staleRunTimeoutMs: number;
  private readonly recentChildrenLimit: number;
  private readonly broadcast: (
    event: string,
    payload: unknown,
    opts?: { dropIfSlow?: boolean },
  ) => void;

  constructor(params: {
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    now?: () => number;
    staleRunTimeoutMs?: number;
    recentChildrenLimit?: number;
  }) {
    this.broadcast = params.broadcast;
    this.now = params.now ?? (() => Date.now());
    this.staleRunTimeoutMs = Math.max(
      1_000,
      params.staleRunTimeoutMs ?? DEFAULT_STALE_RUN_TIMEOUT_MS,
    );
    this.recentChildrenLimit = Math.max(
      1,
      params.recentChildrenLimit ?? DEFAULT_RECENT_CHILDREN_LIMIT,
    );
  }

  noteAgentEvent(params: { evt: AgentEventPayload; resolvedSessionKey?: string }): void {
    const now = this.now();
    const evt = params.evt;
    const eventSessionKey =
      normalizeSessionKey(evt.sessionKey) ?? normalizeSessionKey(params.resolvedSessionKey);
    const impactedSessions = new Set<string>();

    const existingRun = this.activeRuns.get(evt.runId);
    const runSessionKey = eventSessionKey ?? existingRun?.sessionKey;
    if (runSessionKey) {
      impactedSessions.add(runSessionKey);
    }
    if (existingRun?.sessionKey && existingRun.sessionKey !== runSessionKey) {
      impactedSessions.add(existingRun.sessionKey);
    }

    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start" && runSessionKey) {
        const startedAt = normalizeTimestamp(evt.data?.startedAt, now);
        const lastActivityAt = normalizeTimestamp(evt.ts, now);
        this.startRun({
          runId: evt.runId,
          sessionKey: runSessionKey,
          startedAt,
          lastActivityAt,
        });
      } else if ((phase === "end" || phase === "error") && runSessionKey) {
        this.endRun({
          runId: evt.runId,
          sessionKey: runSessionKey,
          endedAt: normalizeTimestamp(evt.data?.endedAt, now),
        });
        this.clearAwaitingUserRun(evt.runId, runSessionKey);
      } else if (runSessionKey) {
        this.touchRunActivity(evt.runId, runSessionKey, normalizeTimestamp(evt.ts, now));
      }
    } else {
      if (runSessionKey) {
        this.touchRunActivity(evt.runId, runSessionKey, normalizeTimestamp(evt.ts, now));
      }
      if (evt.stream === "tool" && runSessionKey) {
        const toolName = normalizeToolName(evt.data?.name);
        if (isAwaitingUserToolName(toolName)) {
          const phase = normalizeToolName(evt.data?.phase);
          if (phase === "start") {
            this.setAwaitingUserRun({
              runId: evt.runId,
              sessionKey: runSessionKey,
              since: normalizeTimestamp(evt.ts, now),
            });
          } else if (phase === "result" || phase === "error" || phase === "end") {
            this.clearAwaitingUserRun(evt.runId, runSessionKey);
          }
        }
      }
    }

    if (eventSessionKey) {
      const requester = resolveRequesterForChildSession(eventSessionKey);
      if (requester?.requesterSessionKey) {
        impactedSessions.add(requester.requesterSessionKey);
      }
    }

    for (const sessionKey of impactedSessions) {
      this.publishStateChangeIfNeeded(sessionKey);
    }
  }

  noteApprovalRequested(params: {
    id: string;
    sessionKey?: string | null;
    createdAtMs: number;
    expiresAtMs: number;
  }): void {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const id = normalizeSessionKey(params.id);
    if (!sessionKey || !id) {
      return;
    }
    const createdAtMs = normalizeTimestamp(params.createdAtMs, this.now());
    const expiresAtMs = normalizeTimestamp(
      params.expiresAtMs,
      createdAtMs + this.staleRunTimeoutMs,
    );
    this.pendingApprovals.set(id, {
      id,
      sessionKey,
      createdAtMs,
      expiresAtMs,
    });
    const state = this.ensureSessionState(sessionKey);
    state.pendingApprovalIds.add(id);
    this.publishStateChangeIfNeeded(sessionKey);
  }

  noteApprovalResolved(approvalId: string): void {
    const id = normalizeSessionKey(approvalId);
    if (!id) {
      return;
    }
    const existing = this.pendingApprovals.get(id);
    if (!existing) {
      return;
    }
    this.pendingApprovals.delete(id);
    const state = this.states.get(existing.sessionKey);
    if (state) {
      state.pendingApprovalIds.delete(id);
      this.publishStateChangeIfNeeded(existing.sessionKey);
    }
  }

  sweep(): void {
    const now = this.now();
    this.sweepExpiredApprovals(now);
    this.sweepStaleRuns(now);
  }

  getKnownSessionKeys(): string[] {
    const keys = new Set<string>();
    for (const key of this.states.keys()) {
      keys.add(key);
    }
    for (const run of this.activeRuns.values()) {
      keys.add(run.sessionKey);
    }
    for (const approval of this.pendingApprovals.values()) {
      keys.add(approval.sessionKey);
    }
    for (const waiting of this.awaitingUserRuns.values()) {
      keys.add(waiting.sessionKey);
    }
    return Array.from(keys);
  }

  getSessionActivity(sessionKeyRaw: string): SessionActivitySnapshot {
    const sessionKey = normalizeSessionKey(sessionKeyRaw);
    if (!sessionKey) {
      return {
        sessionKey: sessionKeyRaw,
        version: 0,
        runtimeActivity: {
          busy: false,
          activeRuns: 0,
          busySince: null,
          lastRunActivityAt: null,
          staleRuns: 0,
        },
        attention: { state: "none", since: null },
        children: { total: 0, active: 0, failed: 0, recent: [] },
      };
    }
    return this.buildSnapshot(sessionKey);
  }

  private ensureSessionState(sessionKey: string): SessionTrackerState {
    let state = this.states.get(sessionKey);
    if (!state) {
      state = {
        version: 0,
        activeRunIds: new Set<string>(),
        pendingApprovalIds: new Set<string>(),
        awaitingUserRunIds: new Set<string>(),
        lastRunActivityAt: null,
        staleRuns: 0,
        signature: "",
      };
      this.states.set(sessionKey, state);
    }
    return state;
  }

  private setAwaitingUserRun(params: { runId: string; sessionKey: string; since: number }) {
    const existing = this.awaitingUserRuns.get(params.runId);
    if (existing && existing.sessionKey === params.sessionKey) {
      return;
    }
    if (existing) {
      const previousState = this.states.get(existing.sessionKey);
      previousState?.awaitingUserRunIds.delete(params.runId);
    }
    this.awaitingUserRuns.set(params.runId, {
      runId: params.runId,
      sessionKey: params.sessionKey,
      since: params.since,
    });
    const state = this.ensureSessionState(params.sessionKey);
    state.awaitingUserRunIds.add(params.runId);
  }

  private clearAwaitingUserRun(runId: string, fallbackSessionKey?: string) {
    const existing = this.awaitingUserRuns.get(runId);
    if (!existing) {
      if (fallbackSessionKey) {
        const fallbackState = this.states.get(fallbackSessionKey);
        fallbackState?.awaitingUserRunIds.delete(runId);
      }
      return;
    }
    this.awaitingUserRuns.delete(runId);
    const state = this.states.get(existing.sessionKey);
    state?.awaitingUserRunIds.delete(runId);
  }

  private startRun(params: {
    runId: string;
    sessionKey: string;
    startedAt: number;
    lastActivityAt: number;
  }) {
    const existing = this.activeRuns.get(params.runId);
    if (existing && existing.sessionKey !== params.sessionKey) {
      const previousState = this.states.get(existing.sessionKey);
      previousState?.activeRunIds.delete(params.runId);
    }
    this.activeRuns.set(params.runId, {
      sessionKey: params.sessionKey,
      startedAt: params.startedAt,
      lastActivityAt: params.lastActivityAt,
    });
    const state = this.ensureSessionState(params.sessionKey);
    state.activeRunIds.add(params.runId);
    state.lastRunActivityAt = Math.max(state.lastRunActivityAt ?? 0, params.lastActivityAt);
  }

  private endRun(params: { runId: string; sessionKey: string; endedAt: number }) {
    const existing = this.activeRuns.get(params.runId);
    if (existing) {
      this.activeRuns.delete(params.runId);
      const existingState = this.states.get(existing.sessionKey);
      existingState?.activeRunIds.delete(params.runId);
    }
    const state = this.ensureSessionState(params.sessionKey);
    state.activeRunIds.delete(params.runId);
    state.lastRunActivityAt = Math.max(state.lastRunActivityAt ?? 0, params.endedAt);
  }

  private touchRunActivity(runId: string, sessionKey: string, ts: number) {
    const existing = this.activeRuns.get(runId);
    if (existing) {
      existing.lastActivityAt = Math.max(existing.lastActivityAt, ts);
    }
    const state = this.ensureSessionState(sessionKey);
    state.lastRunActivityAt = Math.max(state.lastRunActivityAt ?? 0, ts);
  }

  private sweepExpiredApprovals(now: number) {
    const affectedSessions = new Set<string>();
    for (const [approvalId, entry] of this.pendingApprovals.entries()) {
      if (entry.expiresAtMs > now) {
        continue;
      }
      this.pendingApprovals.delete(approvalId);
      const state = this.states.get(entry.sessionKey);
      if (state) {
        state.pendingApprovalIds.delete(approvalId);
      }
      affectedSessions.add(entry.sessionKey);
    }
    for (const sessionKey of affectedSessions) {
      this.publishStateChangeIfNeeded(sessionKey);
    }
  }

  private sweepStaleRuns(now: number) {
    const affectedSessions = new Set<string>();
    for (const [runId, entry] of this.activeRuns.entries()) {
      if (now - entry.lastActivityAt <= this.staleRunTimeoutMs) {
        continue;
      }
      this.activeRuns.delete(runId);
      const state = this.ensureSessionState(entry.sessionKey);
      state.activeRunIds.delete(runId);
      state.staleRuns += 1;
      state.lastRunActivityAt = Math.max(state.lastRunActivityAt ?? 0, entry.lastActivityAt);
      this.clearAwaitingUserRun(runId, entry.sessionKey);
      affectedSessions.add(entry.sessionKey);
    }
    for (const sessionKey of affectedSessions) {
      this.publishStateChangeIfNeeded(sessionKey);
    }
  }

  private buildRuntimeActivity(
    sessionKey: string,
    state: SessionTrackerState,
  ): SessionRuntimeActivity {
    let busySince: number | null = null;
    for (const runId of state.activeRunIds) {
      const run = this.activeRuns.get(runId);
      if (!run || run.sessionKey !== sessionKey) {
        continue;
      }
      if (busySince === null || run.startedAt < busySince) {
        busySince = run.startedAt;
      }
    }
    const activeRuns = state.activeRunIds.size;
    return {
      busy: activeRuns > 0,
      activeRuns,
      busySince: activeRuns > 0 ? busySince : null,
      lastRunActivityAt: state.lastRunActivityAt,
      staleRuns: state.staleRuns,
    };
  }

  private buildChildrenRollup(sessionKey: string): SessionChildrenRollup {
    const runs = listSubagentRunsForRequester(sessionKey);
    if (runs.length === 0) {
      return { total: 0, active: 0, failed: 0, recent: [] };
    }

    const sorted = [...runs].toSorted((a, b) => {
      const aStarted = typeof a.startedAt === "number" ? a.startedAt : a.createdAt;
      const bStarted = typeof b.startedAt === "number" ? b.startedAt : b.createdAt;
      return bStarted - aStarted;
    });

    const recent = sorted.slice(0, this.recentChildrenLimit).map((entry) => ({
      childSessionKey: entry.childSessionKey,
      status: deriveChildStatus(entry),
      childRunId: entry.runId,
      label: entry.label,
      startedAt:
        typeof entry.startedAt === "number"
          ? entry.startedAt
          : typeof entry.createdAt === "number"
            ? entry.createdAt
            : undefined,
    }));

    const active = runs.filter((entry) => typeof entry.endedAt !== "number").length;
    const failed = runs.filter(
      (entry) => typeof entry.endedAt === "number" && entry.outcome?.status === "error",
    ).length;

    return {
      total: runs.length,
      active,
      failed,
      recent,
    };
  }

  private buildAttention(
    sessionKey: string,
    runtime: SessionRuntimeActivity,
    children: SessionChildrenRollup,
  ): SessionAttentionActivity {
    const state = this.states.get(sessionKey);
    const now = this.now();
    const pendingApprovals = state
      ? [...state.pendingApprovalIds]
          .map((id) => this.pendingApprovals.get(id))
          .filter((entry): entry is PendingApprovalEntry => Boolean(entry))
          .toSorted((a, b) => a.createdAtMs - b.createdAtMs)
      : [];
    if (pendingApprovals.length > 0) {
      return {
        state: "awaiting_approval",
        since: pendingApprovals[0].createdAtMs,
        note: "Awaiting approval",
        blockedOn: pendingApprovals.map((entry) => ({
          kind: "approval",
          approvalId: entry.id,
          startedAt: entry.createdAtMs,
        })),
      };
    }

    const pendingUser = state
      ? [...state.awaitingUserRunIds]
          .map((id) => this.awaitingUserRuns.get(id))
          .filter((entry): entry is AwaitingUserRunEntry => Boolean(entry))
          .toSorted((a, b) => a.since - b.since)
      : [];
    if (pendingUser.length > 0) {
      return {
        state: "awaiting_user",
        since: pendingUser[0].since,
        note: "Awaiting user input",
      };
    }

    if (!runtime.busy && children.active > 0) {
      const activeChildren = listSubagentRunsForRequester(sessionKey)
        .filter((entry) => typeof entry.endedAt !== "number")
        .toSorted((a, b) => {
          const aStart = typeof a.startedAt === "number" ? a.startedAt : a.createdAt;
          const bStart = typeof b.startedAt === "number" ? b.startedAt : b.createdAt;
          return aStart - bStart;
        });
      return {
        state: "awaiting_subagent",
        since:
          typeof activeChildren[0]?.startedAt === "number"
            ? activeChildren[0].startedAt
            : typeof activeChildren[0]?.createdAt === "number"
              ? activeChildren[0].createdAt
              : now,
        note: "Awaiting subagent",
        blockedOn: buildBlockedOnSubagents(activeChildren),
      };
    }

    return {
      state: "none",
      since: null,
    };
  }

  private buildSignature(snapshot: Omit<SessionActivitySnapshot, "version">): string {
    return JSON.stringify({
      runtime: {
        busy: snapshot.runtimeActivity.busy,
        activeRuns: snapshot.runtimeActivity.activeRuns,
        busySince: snapshot.runtimeActivity.busySince,
        staleRuns: snapshot.runtimeActivity.staleRuns,
      },
      attention: snapshot.attention,
      children: {
        total: snapshot.children.total,
        active: snapshot.children.active,
        failed: snapshot.children.failed,
        recent: snapshot.children.recent,
      },
    });
  }

  private buildSnapshot(sessionKey: string): SessionActivitySnapshot {
    const state = this.ensureSessionState(sessionKey);
    const runtimeActivity = this.buildRuntimeActivity(sessionKey, state);
    const children = this.buildChildrenRollup(sessionKey);
    const attention = this.buildAttention(sessionKey, runtimeActivity, children);
    return {
      sessionKey,
      version: state.version,
      runtimeActivity,
      attention,
      children,
    };
  }

  private publishStateChangeIfNeeded(sessionKey: string): void {
    const state = this.ensureSessionState(sessionKey);
    const snapshot = this.buildSnapshot(sessionKey);
    const signature = this.buildSignature({
      sessionKey: snapshot.sessionKey,
      runtimeActivity: snapshot.runtimeActivity,
      attention: snapshot.attention,
      children: snapshot.children,
    });
    if (signature === state.signature) {
      return;
    }
    state.signature = signature;
    state.version += 1;
    this.broadcast(
      SESSION_ACTIVITY_STATECHANGE_EVENT,
      {
        sessionKey,
        version: state.version,
        ts: this.now(),
      },
      { dropIfSlow: true },
    );
  }
}
