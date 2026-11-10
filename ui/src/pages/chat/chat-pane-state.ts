import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type {
  MessageReactionSummary,
  SessionSharingRole,
  SessionSuggestion,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isChatControlCommand, isModelIndependentChatCommand } from "../../lib/chat/commands.ts";
import {
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
} from "../../lib/chat/follow-up-mode.ts";
import { currentDisplayRuntimeConfig } from "../../lib/config/config-state-model.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { chatSendPendingReason } from "./chat-send-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatTypingActorView, ChatTypingOverflow } from "./chat-typing-presence.ts";
import type { ChatProps } from "./chat-view.tsx";
import type { ChatSessionSharingState } from "./components/chat-session-sharing-shared.tsx";
import { dismissChatRunError, hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";

registerChatSessionEnglish();

export function createChatPaneCollaborationState(): {
  sharingStates: Map<string, ChatSessionSharingState>;
  suggestions: SessionSuggestion[];
  role: SessionSharingRole | undefined;
  busyIds: Set<string>;
  addOperation: symbol | undefined;
  editOperation: symbol | undefined;
  typingViews: ChatTypingActorView[];
  typingOverflow: ChatTypingOverflow | undefined;
  reactions: Map<string, MessageReactionSummary[]>;
} {
  return {
    sharingStates: new Map(),
    suggestions: [],
    role: undefined,
    busyIds: new Set(),
    addOperation: undefined,
    editOperation: undefined,
    typingViews: [],
    typingOverflow: undefined,
    reactions: new Map(),
  };
}

export function createChatPaneRunRecoveryActions(
  state: Pick<
    ChatPageHost,
    | "sessionKey"
    | "connected"
    | "chatRunId"
    | "chatSending"
    | "handleSendChat"
    | "chatMessages"
    | "chatMessage"
    | "chatAttachments"
    | "chatMentions"
    | "chatReplyTarget"
    | "chatGoalDraftMode"
    | "chatRunError"
    | "chatDismissedRunErrorId"
  >,
  options: {
    canSend: boolean;
    isCurrent: () => boolean;
    latestFailedRunId: () => string | undefined;
    onRewindMessage?: ChatProps["onRewindMessage"];
  },
): Pick<ChatProps, "onRetryRun" | "failedMessageEditSource" | "onDismissRunError"> {
  const sessionKey = state.sessionKey;
  const ownsFailure = (runId: string) =>
    options.isCurrent() &&
    state.sessionKey === sessionKey &&
    state.connected &&
    !state.chatRunId &&
    !state.chatSending &&
    options.latestFailedRunId() === runId;
  const failedRunId = options.latestFailedRunId();
  const rewind = options.onRewindMessage;
  return {
    failedMessageEditSource:
      rewind && failedRunId
        ? {
            state,
            runId: failedRunId,
            isCurrent: () => ownsFailure(failedRunId),
            readIdentity: readSessionMessageIdentity,
            rewind,
          }
        : undefined,
    onRetryRun: options.canSend
      ? (runId) => {
          if (ownsFailure(runId)) {
            // Continue with the existing history, rather than replaying a prompt
            // whose tools may already have completed side effects.
            void state.handleSendChat(t("chat.recovery.continuePrompt"));
          }
        }
      : undefined,
    // Reply failures can be dismissed; placement failures keep their recovery action.
    onDismissRunError: state.chatRunError ? () => dismissChatRunError(state) : undefined,
  };
}

export function createChatPaneSendActions(
  state: Pick<ChatPageHost, "chatAttachments" | "chatMessage" | "handleSendChat">,
  options: {
    canSend: boolean;
    modelRequiredReason?: string | null;
    continueSession?: () => ReturnType<ChatProps["onSend"]>;
    addSuggestion?: () => ReturnType<ChatProps["onSend"]>;
  },
): Pick<ChatProps, "onSend" | "onPermissionRetry"> {
  return {
    onPermissionRetry:
      options.canSend && !options.continueSession && !options.addSuggestion
        ? (message) => void state.handleSendChat(message)
        : undefined,
    onSend: (followUpModeOverride, submissionAction) => {
      if (
        !options.canSend ||
        (options.modelRequiredReason &&
          (state.chatAttachments.length > 0 || !isModelIndependentChatCommand(state.chatMessage)))
      ) {
        return;
      }
      if (options.continueSession) {
        return options.continueSession();
      }
      if (options.addSuggestion) {
        return options.addSuggestion();
      }
      return state.handleSendChat(
        undefined,
        followUpModeOverride ? { followUpMode: followUpModeOverride } : undefined,
        submissionAction,
      );
    },
  };
}

export function applySelectedSessionProjection(
  state: {
    chatEffectiveQueueMode?: GatewaySessionRow["effectiveQueueMode"];
    chatQueueModeOverride?: GatewaySessionRow["queueMode"];
    selectedChatSessionArchived: boolean;
    selectedChatSessionIncognito: boolean;
  },
  session: GatewaySessionRow | undefined,
): session is GatewaySessionRow {
  if (!session) {
    return false;
  }
  state.selectedChatSessionArchived = session.archived === true;
  state.selectedChatSessionIncognito = session.incognito === true;
  state.chatQueueModeOverride = session.queueMode;
  state.chatEffectiveQueueMode = session.effectiveQueueMode;
  return true;
}

const MAX_TRACKED_SESSION_ROWS = 256;

export class SessionParticipationTracker {
  private readonly lastBlocked = new Map<string, boolean>();

  reset(): void {
    this.lastBlocked.clear();
  }

  resolve(params: {
    catalog: boolean;
    listLoading: boolean;
    sessionKey: string;
    session: Pick<GatewaySessionRow, "sharingRole" | "visibility"> | undefined;
  }): boolean {
    if (params.catalog) {
      return false;
    }
    if (params.session) {
      const blocked =
        params.session.visibility === "draft"
          ? params.session.sharingRole !== "admin" && params.session.sharingRole !== "owner"
          : params.session.visibility !== undefined &&
            params.session.visibility !== "shared" &&
            params.session.sharingRole === "viewer";
      this.lastBlocked.delete(params.sessionKey);
      this.lastBlocked.set(params.sessionKey, blocked);
      if (this.lastBlocked.size > MAX_TRACKED_SESSION_ROWS) {
        const oldest = this.lastBlocked.keys().next().value;
        if (oldest) {
          this.lastBlocked.delete(oldest);
        }
      }
      return blocked;
    }
    // The selected session has no row. Absence is NOT a revocation signal:
    // filtering, search, pagination, and deletion all remove a row the caller
    // can still write to, so inferring a block would wrongly disable a valid
    // session. Block only on a positively observed restricted state above.
    // During an in-flight refresh, hold the last known block so a restricted
    // session does not flicker enabled; a completed absence never blocks. The
    // redaction case (a session hidden from a non-owner) is handled once the
    // explicit revocation signal lands (openclaw/openclaw#112760).
    return params.listLoading && this.lastBlocked.get(params.sessionKey) === true;
  }
}

export function dismissChatError(state: { chatError?: string | null; lastError: string | null }) {
  state.lastError = null;
  state.chatError = null;
}

export function chatSubmitState(
  state: ChatState & Pick<ChatPageHost, "handleChatDraftChange" | "sessionsResult">,
  unavailable: boolean,
  nativeChat: boolean,
) {
  const historyLoad = getChatHistoryLoadState(state);
  const failure = unavailable && historyLoad.phase === "failed" ? historyLoad.message : null;
  const pendingReason = nativeChat ? chatSendPendingReason(state, state.sessionKey) : null;
  const connectionPendingReason = nativeChat
    ? chatSendPendingReason({ client: state.client, connected: state.connected }, state.sessionKey)
    : null;
  const controlCommand = isChatControlCommand(state.chatMessage);
  const routePending = state.isRouteSessionPending?.() === true;
  return {
    goalResumeBusy: isChatBusy(state) || hasDirectSessionRun(state),
    ...(routePending || (connectionPendingReason && !controlCommand) ? { canSend: false } : {}),
    submitDisabledReason:
      pendingReason ?? (routePending || unavailable ? (failure ?? t("chat.thread.loading")) : null),
    submitPending:
      routePending || pendingReason !== null || (unavailable && historyLoad.phase !== "failed"),
    onDraftChange: (...args: Parameters<ChatPageHost["handleChatDraftChange"]>) => {
      state.handleChatDraftChange(...args);
    },
  };
}

export function resolveChatPaneFollowUpMode(
  state: Pick<ChatPageHost, "settings" | "chatEffectiveQueueMode" | "chatQueueModeOverride">,
  session: GatewaySessionRow | undefined,
  runtimeConfig: ApplicationContext["runtimeConfig"]["state"],
) {
  return resolveControlUiFollowUpMode(
    state.settings.chatFollowUpMode,
    resolveControlUiServerQueueMode(currentDisplayRuntimeConfig(runtimeConfig), {
      configNeedsApply: runtimeConfig.configNeedsApply,
      effectiveMode: state.chatEffectiveQueueMode,
      sessionMetadataLoaded: session !== undefined || state.chatEffectiveQueueMode !== undefined,
      sessionMode: state.chatQueueModeOverride,
    }),
  );
}
