import { onAgentEvent, setPlanModeSubagentGatePersistenceHandler } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  persistPlanModeSubagentGateState,
  startPlanSnapshotPersister,
} from "./plan-snapshot-persister.js";
import {
  createAgentEventHandler,
  type ChatRunState,
  type SessionEventSubscriberRegistry,
  type SessionMessageSubscriberRegistry,
  type ToolEventRecipientRegistry,
} from "./server-chat.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";

export function startGatewayEventSubscriptions(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, unknown>;
}) {
  const agentUnsub = onAgentEvent(
    createAgentEventHandler({
      broadcast: params.broadcast,
      broadcastToConnIds: params.broadcastToConnIds,
      nodeSendToSession: params.nodeSendToSession,
      agentRunSeq: params.agentRunSeq,
      chatRunState: params.chatRunState,
      resolveSessionKeyForRun: params.resolveSessionKeyForRun,
      clearAgentRunContext: params.clearAgentRunContext,
      toolEventRecipients: params.toolEventRecipients,
      sessionEventSubscribers: params.sessionEventSubscribers,
      isChatSendRunActive: (runId) => params.chatAbortControllers.has(runId),
    }),
  );

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onSessionTranscriptUpdate(
    createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds: params.broadcastToConnIds,
      sessionEventSubscribers: params.sessionEventSubscribers,
      sessionMessageSubscribers: params.sessionMessageSubscribers,
    }),
  );

  const lifecycleUnsub = onSessionLifecycleEvent(
    createLifecycleEventBroadcastHandler({
      broadcastToConnIds: params.broadcastToConnIds,
      sessionEventSubscribers: params.sessionEventSubscribers,
    }),
  );

  // PR-8 follow-up: persist live plan snapshot to SessionEntry.planMode
  // after each update_plan call so the Control UI can rebuild the
  // live-plan sidebar after a hard refresh. See
  // `plan-snapshot-persister.ts` for details.
  //
  // PR-11 review fix (Copilot #3105169600): wire `emitSessionsChanged`
  // so the persister broadcasts `sessions.changed` to UI subscribers
  // when it writes `lastPlanSteps` or auto-flips `planMode → "normal"`
  // on close-on-complete. Without this, the persister silently mutates
  // session state outside the `sessions.patch` RPC handler and the UI
  // never gets a refresh signal — the live-plan sidebar drifts behind
  // the runtime until the user manually refreshes.
  // Consolidation pass note: removed the `params.minimalTestGateway`
  // conditional from PR-11 because the param was renamed/dropped in
  // upstream's restructure. This module now always wires a concrete
  // `emitSessionsChanged`; tests that need to suppress broadcasts
  // should use `sessionEventSubscribers` with no conn ids (so
  // `getAll()` returns an empty set and the early-return at line
  // 89 below short-circuits the broadcast) or otherwise provide
  // no-op broadcast plumbing in the test harness — there's no
  // injected emitter param to override here.
  // Copilot review #68939 (post-nuclear-fix-stack): comment
  // updated to reflect the actual suppression mechanism (the
  // earlier "pass a noop emitSessionsChanged" wording implied a
  // param that doesn't exist).
  const stopPlanModeSubagentGatePersistence = setPlanModeSubagentGatePersistenceHandler(
    persistPlanModeSubagentGateState,
  );

  const stopPlanSnapshotListener = startPlanSnapshotPersister({
    emitSessionsChanged: ({ sessionKey, reason }) => {
      const connIds = params.sessionEventSubscribers.getAll();
      if (connIds.size === 0) {
        return;
      }
      params.broadcastToConnIds(
        "sessions.changed",
        { sessionKey, reason, ts: Date.now() },
        connIds,
      );
    },
  });
  const planSnapshotUnsub = () => {
    stopPlanSnapshotListener();
    stopPlanModeSubagentGatePersistence();
  };

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    planSnapshotUnsub,
  };
}
