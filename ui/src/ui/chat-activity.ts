import type { SessionRunStatus } from "./types.ts";

export type ChatTerminalKind = "completed" | "aborted" | "error";

export type ChatActivityKind =
  | "idle"
  | "submitting"
  | "streaming"
  | "running_tool"
  | "awaiting_approval"
  | "silent_processing"
  | "reconnecting"
  | "completed"
  | "error"
  | "unknown";

export type ChatActivityState = {
  kind: ChatActivityKind;
  summaryKind: "idle" | "in_progress" | "interrupted" | "completed";
  label: string;
  detail: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  isBusy: boolean;
};

export type ChatActivityEvidence = {
  now?: number;
  connected: boolean;
  sending: boolean;
  runId: string | null;
  stream: string | null;
  activeToolCallCount?: number | null;
  reconnectPendingAt?: number | null;
  lastActivityAt?: number | null;
  lastToolActivityAt?: number | null;
  lastTerminalAt?: number | null;
  lastTerminalKind?: ChatTerminalKind | null;
  sessionStatus?: SessionRunStatus;
  sessionEndedAt?: number;
  currentSessionApproval?: ResolvedChatApproval | null;
};

export type ChatApprovalKind = "exec" | "plugin";

export type ChatApprovalEvidence = {
  kind: ChatApprovalKind;
  sessionKey: string | null;
  createdAtMs: number;
};

export type ResolvedChatApproval = {
  kind: ChatApprovalKind | "mixed";
  count: number;
  createdAtMs: number;
};

const RECONNECT_RECONCILIATION_MS = 15_000;
const STALE_SESSION_RUNNING_GRACE_MS = 5_000;

function buildState(
  kind: ChatActivityKind,
  summaryKind: ChatActivityState["summaryKind"],
  label: string,
  detail: string | null,
  startedAt: number | null,
  lastActivityAt: number | null,
  isBusy: boolean,
): ChatActivityState {
  return { kind, summaryKind, label, detail, startedAt, lastActivityAt, isBusy };
}

export function resolveCurrentSessionApproval(
  approvals: ChatApprovalEvidence[] | undefined,
  sessionKey: string,
): ResolvedChatApproval | null {
  if (!approvals || approvals.length === 0) {
    return null;
  }
  const matching = approvals.filter((entry) => entry.sessionKey === sessionKey);
  if (matching.length === 0) {
    return null;
  }
  const kindSet = new Set(matching.map((entry) => entry.kind));
  const newestCreatedAtMs = matching.reduce(
    (latest, entry) => Math.max(latest, entry.createdAtMs),
    0,
  );
  return {
    kind:
      kindSet.size === 1
        ? (matching[0]?.kind ?? "exec")
        : "mixed",
    count: matching.length,
    createdAtMs: newestCreatedAtMs,
  };
}

function describeApproval(approval: ResolvedChatApproval): string {
  if (approval.count > 1) {
    return `${approval.count} approvals are blocking this run.`;
  }
  if (approval.kind === "plugin") {
    return "A plugin approval is blocking this run.";
  }
  if (approval.kind === "exec") {
    return "An exec approval is blocking this run.";
  }
  return "An approval is blocking this run.";
}

export function resolveChatActivityState(evidence: ChatActivityEvidence): ChatActivityState {
  const now = evidence.now ?? Date.now();
  const activeToolCallCount = Math.max(0, evidence.activeToolCallCount ?? 0);
  const hasVisibleStream =
    typeof evidence.stream === "string" && evidence.stream.trim().length > 0;
  const reconnectReconciling =
    evidence.reconnectPendingAt != null &&
    now - evidence.reconnectPendingAt < RECONNECT_RECONCILIATION_MS;
  const latestActivityAt =
    [evidence.lastActivityAt, evidence.lastToolActivityAt].filter(
      (value): value is number => typeof value === "number",
    ).toSorted((a, b) => b - a)[0] ?? null;
  const latestNonTerminalActivityAt =
    [latestActivityAt, evidence.currentSessionApproval?.createdAtMs].filter(
      (value): value is number => typeof value === "number",
    ).toSorted((a, b) => b - a)[0] ?? null;
  const hasDirectActiveEvidence =
    evidence.sending ||
    evidence.runId != null ||
    hasVisibleStream ||
    activeToolCallCount > 0 ||
    reconnectReconciling ||
    evidence.currentSessionApproval != null;
  const sessionRunning =
    evidence.sessionStatus === "running" &&
    evidence.sessionEndedAt == null &&
    (evidence.runId != null ||
      (latestActivityAt != null && now - latestActivityAt < STALE_SESSION_RUNNING_GRACE_MS));
  const terminalSuppressesBusy =
    evidence.lastTerminalAt != null &&
    (!hasDirectActiveEvidence ||
      latestNonTerminalActivityAt == null ||
      evidence.lastTerminalAt >= latestNonTerminalActivityAt);

  if (!evidence.connected) {
    if (
      evidence.runId ||
      evidence.stream !== null ||
      activeToolCallCount > 0 ||
      reconnectReconciling
    ) {
      return buildState(
        "reconnecting",
        "in_progress",
        "Reconnecting to the gateway",
        "Checking whether the previous run is still active.",
        evidence.reconnectPendingAt ?? latestActivityAt,
        latestActivityAt,
        true,
      );
    }
    return buildState("idle", "idle", "Idle", null, null, latestActivityAt, false);
  }

  if (evidence.sending) {
    return buildState(
      "submitting",
      "in_progress",
      "Submitting message",
      "Starting a new run.",
      latestActivityAt,
      latestActivityAt,
      true,
    );
  }

  if (terminalSuppressesBusy) {
    if (evidence.lastTerminalKind === "error") {
      return buildState(
        "error",
        "interrupted",
        "Run failed",
        "The last run ended with an error.",
        evidence.lastTerminalAt ?? null,
        latestActivityAt,
        false,
      );
    }
    if (evidence.lastTerminalKind === "aborted") {
      return buildState(
        "completed",
        "interrupted",
        "Run stopped",
        "The last run was aborted.",
        evidence.lastTerminalAt ?? null,
        latestActivityAt,
        false,
      );
    }
    if (evidence.lastTerminalKind === "completed") {
      return buildState(
        "completed",
        "completed",
        "Run finished",
        "The last run completed.",
        evidence.lastTerminalAt ?? null,
        latestActivityAt,
        false,
      );
    }
  }

  if (evidence.currentSessionApproval) {
    return buildState(
      "awaiting_approval",
      "in_progress",
      "Waiting for approval",
      describeApproval(evidence.currentSessionApproval),
      null,
      latestActivityAt,
      true,
    );
  }

  if (hasVisibleStream) {
    return buildState(
      "streaming",
      "in_progress",
      "Replying now",
      "Receiving live output.",
      latestActivityAt,
      latestActivityAt,
      true,
    );
  }

  if (activeToolCallCount > 0) {
    return buildState(
      "running_tool",
      "in_progress",
      "Running tools",
      `${activeToolCallCount} active tool call${activeToolCallCount === 1 ? "" : "s"}.`,
      evidence.lastToolActivityAt ?? latestActivityAt,
      latestActivityAt,
      true,
    );
  }

  if (evidence.runId || sessionRunning) {
    return buildState(
      "silent_processing",
      "in_progress",
      "Run still active",
      "The run has not finished and there is no new output yet.",
      latestActivityAt,
      latestActivityAt,
      true,
    );
  }

  if (reconnectReconciling) {
    return buildState(
      "unknown",
      "in_progress",
      "Status unknown",
      "Reconnected, still reconciling the previous run.",
      evidence.reconnectPendingAt ?? latestActivityAt,
      latestActivityAt,
      true,
    );
  }

  return buildState("idle", "idle", "Idle", null, null, latestActivityAt, false);
}
