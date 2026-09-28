import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { sameSelfUserIdentity } from "../../app/user-profile.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  resolveCappedMessageId,
  resolveSourceMessageId,
  sameSavedInputSource,
  type AssistantMessageExpansionState,
} from "./chat-message-recovery.ts";
import {
  getChatPendingInputs,
  isSavedChatInput,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { messageMatchesSearchQuery } from "./chat-thread-items.ts";
import type { ChatProps } from "./chat-view.ts";
import { prepareChatMessageRender } from "./components/chat-message-markdown.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import { selectChatInputDisplay } from "./history-merge.ts";

export type SavedChatInput = ChatPendingInputsPage["items"][number];
type Inspection = { source: SavedChatInput; state?: AssistantMessageExpansionState };
type InspectionScope = {
  client: ChatState["client"];
  epoch: number;
  sessionKey: string;
  sessionId: string | null;
  agentId: string | undefined;
  viewer: ChatState["selfUser"];
  signal: AbortSignal | undefined;
  inspections: Map<string, Inspection>;
};
const scopes = new WeakMap<ChatState, InspectionScope>();

function ownsScope(state: ChatState, scope: InspectionScope) {
  return (
    scopes.get(state) === scope &&
    state.client === scope.client &&
    state.connectionEpoch === scope.epoch &&
    state.sessionKey === scope.sessionKey &&
    (state.currentSessionId ?? null) === scope.sessionId &&
    resolveUiSelectedSessionAgentId(state) === scope.agentId &&
    sameSelfUserIdentity(state.selfUser, scope.viewer) &&
    !scope.signal?.aborted
  );
}
function savedInputs(state: ChatState): SavedChatInput[] {
  const view = getChatPendingInputs(state);
  if (!view) {
    return [];
  }
  // The existing active snapshot owns running/waiting custody even while the
  // retained page still shows an interrupted copy from before re-admission.
  const activeIds = new Set(view.activeInputs.map((input) => input.id));
  const activeRuns = new Set(
    view.activeInputs.flatMap((input) => (input.runId ? [input.runId] : [])),
  );
  return selectChatInputDisplay(
    state.chatMessages,
    state.chatQueue,
    view.page.items,
  ).pendingInputs.filter(
    (input) =>
      isSavedChatInput(input, state.chatQueue) &&
      !activeIds.has(input.id) &&
      !(input.runId && activeRuns.has(input.runId)),
  );
}

/** Pane-local display only. Never admits, edits, dismisses, or sends custody. */
export function createChatSavedInputs(props: ChatProps) {
  const state = props.historyState;
  if (!state) {
    return undefined;
  }
  const page = getChatPendingInputs(state);
  let scope = scopes.get(state);
  if (scope && (!ownsScope(state, scope) || scope.signal !== props.readSignal)) {
    scopes.delete(state);
    scope = undefined;
  }
  // Offline content belongs only to a scope already viewed on this connection.
  // A reconnect read cannot certify the old retained page by merely starting.
  if (
    !page ||
    page.pageClient !== state.client ||
    page.pageEpoch !== state.connectionEpoch ||
    !sameSelfUserIdentity(page.pageViewer, state.selfUser) ||
    props.readSignal?.aborted ||
    (!scope && !state.connected)
  ) {
    return undefined;
  }
  if (!scope) {
    scope = {
      client: state.client,
      epoch: state.connectionEpoch,
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId ?? null,
      agentId: resolveUiSelectedSessionAgentId(state),
      viewer: state.selfUser,
      signal: props.readSignal,
      inspections: new Map(),
    };
    scopes.set(state, scope);
  }
  const owner = scope;
  const items = savedInputs(state);
  for (const [id, inspection] of owner.inspections) {
    if (!items.some((input) => sameSavedInputSource(input, inspection.source))) {
      owner.inspections.delete(id);
    }
  }
  const current = () =>
    ownsScope(state, owner) &&
    getChatPendingInputs(state) === page &&
    sameSelfUserIdentity(page.pageViewer, state.selfUser) &&
    getChatPendingInputs(state)?.pageClient === owner.client &&
    getChatPendingInputs(state)?.pageEpoch === owner.epoch;
  const requestUpdate = props.onRequestUpdate ?? (() => state.requestUpdate?.());
  const onToggle = async (input: SavedChatInput, open: boolean) => {
    if (!current() || !savedInputs(state).some((row) => sameSavedInputSource(row, input))) {
      return;
    }
    if (!open) {
      owner.inspections.delete(input.id);
      requestUpdate();
      return;
    }
    const existing = owner.inspections.get(input.id);
    if (existing && existing.state?.status !== "error") {
      return;
    }
    const inspection: Inspection = { source: input };
    owner.inspections.set(input.id, inspection);
    const prepared = prepareChatMessageRender(input.message);
    const messageId = resolveCappedMessageId(input.message, prepared.normalizedMessage.role);
    if (!messageId) {
      requestUpdate();
      return;
    }
    const loader = props.loadFullAssistantMessage;
    if (!state.connected || !loader) {
      inspection.state = { status: "error", revision: 0 };
      requestUpdate();
      return;
    }
    inspection.state = { status: "loading", revision: 0 };
    requestUpdate();
    const ownsRead = () =>
      current() &&
      state.connected &&
      owner.inspections.get(input.id) === inspection &&
      savedInputs(state).some((row) => sameSavedInputSource(row, inspection.source));
    try {
      const result = await loader({
        sessionKey: owner.sessionKey,
        agentId: owner.agentId,
        messageId,
      });
      if (!ownsRead()) {
        return;
      }
      if (!result?.ok || resolveSourceMessageId(result.message) !== messageId) {
        throw new Error("Saved input unavailable");
      }
      const full = prepareChatMessageRender(result.message);
      if (resolveCappedMessageId(result.message, full.normalizedMessage.role)) {
        throw new Error("Saved input still capped");
      }
      inspection.state = {
        status: "loaded",
        message: result.message,
        markdown: full.displayMarkdown,
        revision: 1,
      };
    } catch {
      if (ownsRead()) {
        inspection.state = { status: "error", revision: 1 };
      }
    } finally {
      if (current() && owner.inspections.get(input.id) === inspection) {
        // A disconnected in-flight read is retried explicitly, never automatically.
        if (inspection.state?.status === "loading") {
          inspection.state = { status: "error", revision: 1 };
        }
        requestUpdate();
      }
    }
  };
  const search = getTranscriptState(props.paneId);
  const recovery = props.transcript.messageRecovery;
  const visible =
    search.searchOpen && search.searchQuery.trim()
      ? items.filter((input) =>
          messageMatchesSearchQuery(
            input.message,
            search.searchQuery,
            recovery
              ? { messages: recovery, revision: 0, agentId: props.fullMessageAgentId }
              : undefined,
          ),
        )
      : items;
  if (
    !visible.length &&
    page.before === undefined &&
    page.page.nextBefore === undefined &&
    !page.error
  ) {
    return undefined;
  }
  return {
    items: visible,
    inspections: owner.inspections,
    onToggle,
    error: page.error,
    loading: page.loading,
    earlier: page.page.nextBefore !== undefined,
    latest: page.before !== undefined,
    canRead: state.connected,
    onPage: (earlier: boolean) => {
      if (current() && state.connected) {
        void loadChatPendingInputs(state, earlier ? page.page.nextBefore : undefined);
      }
    },
  };
}
export type ChatSavedInputs = NonNullable<ReturnType<typeof createChatSavedInputs>>;
