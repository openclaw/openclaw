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
    request: {
      command: presentation.kind === "exec" ? presentation.commandText : presentation.title,
      agentId: presentation.agentId ?? null,
      sessionKey,
      allowedDecisions: presentation.allowedDecisions,
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

export function projectSessionApprovalReplay(
  replay: unknown,
  sessionKey: string,
  selectedAgentId?: string,
): ExecApprovalRequest[] {
  if (!isSessionApprovalReplay(replay)) {
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
  event: unknown,
  sessionKey?: string,
  selectedAgentId?: string,
  onAcceptedEvent?: (event: SessionApprovalEvent) => void,
): ExecApprovalRequest[] | null {
  if (!isSessionApprovalEvent(event)) {
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

export function currentSessionApprovalReplay(
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

/** A complete pending snapshot supersedes the global queue only for this pane's owner. */
export function recordSessionApprovalReplay(
  state: ApprovalReplayHost,
  value: unknown,
  agentId?: string,
): void {
  if (!isSessionApprovalReplay(value)) {
    return;
  }
  const replay = value;
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
}

export function applySessionApprovalEvent(
  state: ApprovalReplayHost & { chatSessionApprovalQueue?: ExecApprovalRequest[] },
  value: unknown,
  agentId?: string,
): boolean {
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
