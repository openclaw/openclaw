import type {
  PendingApprovalSnapshot,
  SessionApprovalEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import {
  isSessionApprovalEvent,
  isSessionApprovalReplay,
} from "../../lib/protocol-validators.generated/approvals.js";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { SessionApprovalReplayState } from "./chat-state-contract.ts";

function approvalStreamMatchesSession(
  streamSessionKey: string,
  sessionKey: string,
  selectedAgentId?: string,
): boolean {
  if (streamSessionKey === sessionKey) {
    return true;
  }
  const stream = parseAgentSessionKey(streamSessionKey);
  return Boolean(
    selectedAgentId &&
    isUiGlobalSessionKey(sessionKey) &&
    stream?.rest === "global" &&
    normalizeAgentId(stream.agentId) === normalizeAgentId(selectedAgentId),
  );
}

function projectPendingApproval(
  approval: PendingApprovalSnapshot,
  sessionKey: string,
  sourceSessionKey?: string,
): ExecApprovalRequest {
  const presentation = approval.presentation;
  const common = {
    id: approval.id,
    ...(approval.canDecide !== undefined ? { canDecide: approval.canDecide } : {}),
    request: {
      command: presentation.kind === "exec" ? presentation.commandText : presentation.title,
      agentId: presentation.agentId ?? null,
      sessionKey,
      allowedDecisions: presentation.allowedDecisions,
      ...(approval.turnActor ? { turnActor: approval.turnActor } : {}),
    },
    ...(sourceSessionKey && sourceSessionKey !== sessionKey ? { sourceSessionKey } : {}),
    createdAtMs: approval.createdAtMs,
    expiresAtMs: approval.expiresAtMs,
  } satisfies Partial<ExecApprovalRequest>;
  if (presentation.kind === "exec") {
    return {
      ...common,
      kind: "exec",
      request: {
        ...common.request,
        host: presentation.host ?? null,
        nodeId: presentation.nodeId ?? null,
        warningText: presentation.warningText ?? null,
        streamProposal: presentation.streamProposal,
      },
    };
  }
  if (presentation.kind === "plugin") {
    return {
      ...common,
      kind: "plugin",
      pluginTitle: presentation.title,
      pluginDescription: presentation.description,
      pluginDetail: presentation.detail,
      pluginSeverity: presentation.severity,
      pluginId: presentation.pluginId ?? null,
    };
  }
  return {
    ...common,
    kind: "system-agent",
    pluginTitle: presentation.title,
    pluginDescription: presentation.description,
    proposalHash: presentation.proposalHash,
  };
}

function readApprovalReplay(value: unknown) {
  return isSessionApprovalReplay(value) ? value : null;
}

function readApprovalEvent(value: unknown) {
  return isSessionApprovalEvent(value) ? value : null;
}

export function projectSessionApprovalReplay(
  value: unknown,
  sessionKey: string,
  selectedAgentId?: string,
): ExecApprovalRequest[] {
  const replay = readApprovalReplay(value);
  if (!replay) {
    return [];
  }
  if (!approvalStreamMatchesSession(replay.sessionKey, sessionKey, selectedAgentId)) {
    return [];
  }
  return replay.approvals.map((approval) =>
    projectPendingApproval(approval, sessionKey, approval.sourceSessionKey),
  );
}

export function reconcileSessionApprovalEvent(
  queue: readonly ExecApprovalRequest[],
  value: unknown,
  sessionKey?: string,
  selectedAgentId?: string,
  onAcceptedEvent?: (event: Exclude<SessionApprovalEvent, { phase: "participant" }>) => void,
): ExecApprovalRequest[] | null {
  const event = readApprovalEvent(value);
  if (!event || event.phase === "participant") {
    return null;
  }
  const presentationSessionKey = sessionKey ?? event.sessionKey;
  if (!approvalStreamMatchesSession(event.sessionKey, presentationSessionKey, selectedAgentId)) {
    return null;
  }
  onAcceptedEvent?.(event);
  if (event.phase === "terminal") {
    return queue.filter((entry) => entry.id !== event.approval.id);
  }
  const next = queue.filter((entry) => entry.id !== event.approval.id);
  next.push(projectPendingApproval(event.approval, presentationSessionKey, event.sourceSessionKey));
  return next.toSorted((left, right) => left.createdAtMs - right.createdAtMs);
}

type ApprovalReplayHost = Pick<
  SessionApprovalReplayState,
  "client" | "connectionEpoch" | "sessionKey"
> & {
  chatSessionApprovalReplay?: SessionApprovalReplayState;
  reconcileApprovalTerminals?: ApplicationOverlays["reconcileApprovalTerminals"];
};

function currentSessionApprovalReplay(
  state: ApprovalReplayHost,
  agentId?: string,
): SessionApprovalReplayState | undefined {
  const current = state.chatSessionApprovalReplay;
  return current?.client === state.client &&
    current?.connectionEpoch === state.connectionEpoch &&
    current?.sessionKey === state.sessionKey &&
    current?.agentId === (isUiGlobalSessionKey(state.sessionKey) ? agentId : undefined)
    ? current
    : undefined;
}

/** Complete replay owns absence; terminal events cannot reappear from the global queue. */
export function currentInlineSessionApproval(
  state: ApprovalReplayHost & { chatSessionApprovalQueue?: ExecApprovalRequest[] },
  agentId: string,
  globalQueue: readonly ExecApprovalRequest[] | undefined,
  matchesConversation: (request: ExecApprovalRequest["request"]) => boolean,
): ExecApprovalRequest | null {
  const pendingReplay = chatHistoryRequests(state).pendingApprovalReplay;
  const isPending = (id: string) => pendingReplay?.events.get(id)?.phase !== "terminal";
  return (
    state.chatSessionApprovalQueue?.find((approval) => isPending(approval.id)) ??
    (currentSessionApprovalReplay(state, agentId)?.complete
      ? null
      : globalQueue?.find(
          (approval) => isPending(approval.id) && matchesConversation(approval.request),
        )) ??
    null
  );
}

/** A complete pending snapshot supersedes the global queue only for this pane's owner. */
export function recordSessionApprovalReplay(
  state: ApprovalReplayHost,
  value: unknown,
  agentId?: string,
): void {
  const replay = readApprovalReplay(value);
  if (!replay) {
    return;
  }
  if (!approvalStreamMatchesSession(replay.sessionKey, state.sessionKey, agentId)) {
    return;
  }
  state.chatSessionApprovalReplay = {
    client: state.client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    agentId: isUiGlobalSessionKey(state.sessionKey) ? agentId : undefined,
    complete: !replay.truncated,
  };
  if (!replay.truncated) {
    participantApprovals.delete(state);
  }
  for (const event of replay.participantApprovals ?? []) {
    applyParticipantApprovalEvent(state, event, agentId);
  }
  const requests = chatHistoryRequests(state);
  if (requests.pendingApprovalReplay?.generation === requests.subscriptionGeneration) {
    for (const event of requests.pendingApprovalReplay.events.values()) {
      if (event.phase === "participant") {
        applyParticipantApprovalEvent(state, event, agentId);
      }
    }
  }
}

export function applySessionApprovalEvent(
  state: ApprovalReplayHost & { chatSessionApprovalQueue?: ExecApprovalRequest[] },
  value: unknown,
  agentId?: string,
): boolean {
  const participant = readApprovalEvent(value);
  if (participant?.phase === "participant") {
    if (!applyParticipantApprovalEvent(state, participant, agentId)) {
      return false;
    }
    const requests = chatHistoryRequests(state);
    const replay = requests.pendingApprovalReplay;
    const previous = replay?.events.get(participant.approvalId);
    if (
      replay?.generation === requests.subscriptionGeneration &&
      !(previous?.phase === "participant" && previous.status === "terminal")
    ) {
      replay.events.set(participant.approvalId, participant);
    }
    return true;
  }
  const queue = reconcileSessionApprovalEvent(
    state.chatSessionApprovalQueue ?? [],
    value,
    state.sessionKey,
    agentId,
    (event) => {
      if (event.phase === "terminal" && state.client) {
        state.reconcileApprovalTerminals?.(state.client, [event]);
      }
      const requests = chatHistoryRequests(state);
      const replay = requests.pendingApprovalReplay;
      if (
        replay?.generation === requests.subscriptionGeneration &&
        replay.events.get(event.approval.id)?.phase !== "terminal"
      ) {
        replay.events.set(event.approval.id, event);
      }
    },
  );
  if (!queue) {
    return false;
  }
  state.chatSessionApprovalQueue = queue;
  return true;
}

export type SessionParticipantApprovalEvent = Extract<
  SessionApprovalEvent,
  { phase: "participant" }
>;

export type ParticipantApprovalNotice = Pick<
  SessionParticipantApprovalEvent,
  "approvalId" | "runId" | "participantId" | "expiresAtMs"
>;

type ParticipantApprovalScope = Omit<SessionApprovalReplayState, "complete"> & {
  generation: number;
  pending: Map<string, ParticipantApprovalNotice>;
};

const participantApprovals = new WeakMap<object, ParticipantApprovalScope>();

function participantApprovalScope(state: ApprovalReplayHost, agentId?: string) {
  const current = participantApprovals.get(state);
  return current?.client === state.client &&
    current?.connectionEpoch === state.connectionEpoch &&
    current?.sessionKey === state.sessionKey &&
    current?.agentId === (isUiGlobalSessionKey(state.sessionKey) ? agentId : undefined) &&
    current?.generation === chatHistoryRequests(state).subscriptionGeneration
    ? current
    : undefined;
}

function applyParticipantApprovalEvent(
  state: ApprovalReplayHost,
  value: SessionParticipantApprovalEvent,
  agentId?: string,
): boolean {
  if (!approvalStreamMatchesSession(value.sessionKey, state.sessionKey, agentId)) {
    return false;
  }
  const { approvalId, runId, participantId } = value;
  const scope = participantApprovalScope(state, agentId) ?? {
    client: state.client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    agentId: isUiGlobalSessionKey(state.sessionKey) ? agentId : undefined,
    generation: chatHistoryRequests(state).subscriptionGeneration,
    pending: new Map<string, ParticipantApprovalNotice>(),
  };
  if (value.status === "terminal") {
    scope.pending.delete(approvalId);
  } else {
    scope.pending.set(approvalId, {
      approvalId,
      runId,
      participantId,
      expiresAtMs: value.expiresAtMs,
    });
  }
  participantApprovals.set(state, scope);
  return true;
}

/** Only the initiating participant sees their notice; no full approval is fetched. */
export function currentParticipantSessionApproval(
  state: ApprovalReplayHost & { connected?: boolean },
  agentId: string,
  participantId: string | null | undefined,
): ParticipantApprovalNotice | null {
  if (!participantId || state.connected === false) {
    return null;
  }
  const now = Date.now();
  return (
    [...(participantApprovalScope(state, agentId)?.pending.values() ?? [])].find(
      (approval) => approval.participantId === participantId && approval.expiresAtMs > now,
    ) ?? null
  );
}
