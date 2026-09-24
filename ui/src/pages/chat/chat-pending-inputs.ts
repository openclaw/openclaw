import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueItem, ChatQueueDisplayItem } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatMessageRecovery } from "./chat-message-recovery.ts";
import { confirmQueuedMessageCustody, removeQueuedMessage } from "./chat-queue.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { buildMessageItems, messageMatchesSearchQuery } from "./chat-thread-items.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reconcileChatInputCustody,
} from "./history-merge.ts";

type PendingInputRequest = {
  before?: number;
  kind: "navigation" | "refresh";
  client: NonNullable<ChatState["client"]>;
  connectionEpoch: number;
};

type PendingInputView = {
  sessionKey: string;
  sessionId: string | null;
  agentId: string | undefined;
  page: ChatPendingInputsPage;
  /** Live custody receipts keep the queue independent of retained-input pagination. */
  queuedInputs: ChatPendingInputsPage["items"];
  before?: number;
  readonly loading: boolean;
  error?: string;
  revision: number;
  request?: PendingInputRequest;
};
const pendingInputViews = new WeakMap<ChatState, PendingInputView>();

function reconcileQueuedInputs(
  queued: ChatPendingInputsPage["items"],
  page: ChatPendingInputsPage,
  receipts: ChatInputReceipts = [],
): ChatPendingInputsPage["items"] {
  const observed = new Map(receipts.map((receipt) => [receipt.runId, receipt]));
  const current = new Map(
    queued
      .filter((input) => {
        const receipt = input.runId ? observed.get(input.runId) : undefined;
        return !receipt || (receipt.state === "pending" && receipt.queued);
      })
      .map((input) => [input.id, input]),
  );
  for (const input of page.items) {
    if (input.queued) {
      current.set(input.id, input);
    } else {
      current.delete(input.id);
    }
  }
  return [...current.values()].toSorted((left, right) => left.acceptedAt - right.acceptedAt);
}

export function buildPendingInputQueueItems(
  inputs: ChatPendingInputsPage["items"],
): ChatQueueDisplayItem[] {
  return inputs.flatMap<ChatQueueDisplayItem>((input) => {
    if (!input.queued || input.state !== "queued" || !input.runId) {
      return [];
    }
    const message = normalizeMessage(input.message);
    const attachmentLabels = message.content.flatMap((part) =>
      part.type === "attachment" || part.type === "attachment_error"
        ? [part.attachment.label]
        : part.type === "image"
          ? part.sources.flatMap((source) => (source.fileName ? [source.fileName] : []))
          : [],
    );
    const imageCount = message.content.filter((part) => part.type === "image").length;
    return [
      {
        id: `pending-input:${input.id}`,
        text:
          extractText(input.message) ||
          attachmentLabels.join(", ") ||
          (imageCount ? t("chat.queue.imageCount", { count: String(imageCount) }) : ""),
        createdAt: input.acceptedAt,
        pendingRunId: input.runId,
        serverQueued: true,
        sender: message.sender ?? undefined,
      },
    ];
  });
}

export function buildPendingInputItems(
  inputs: ChatPendingInputsPage["items"],
  searchQuery?: string,
  browserInputs: readonly ChatQueueItem[] = [],
  workspaceSyncPendingRunIds: readonly string[] = [],
  workerSetupPending = false,
  messageRecovery?: ChatMessageRecovery,
): ChatItem[] {
  // Custody records stay outside active-run ordering until the writer promotes them.
  const items: ChatItem[] = [];
  if (!inputs.length) {
    return items;
  }
  for (const input of inputs) {
    if (
      searchQuery?.trim() &&
      !messageMatchesSearchQuery(input.message, searchQuery, messageRecovery)
    ) {
      continue;
    }
    // Custody keeps submission correlation outside the message; use it for
    // presentation without inventing transcript or execution identity.
    items.push(
      ...buildMessageItems([input.message], () =>
        input.runId ? `send:${input.runId}` : `pending-input:${input.id}`,
      ).flatMap((item) => projectChatSystemNotice({ ...item, startsTurn: true }) ?? []),
    );
    if (input.state === "queued") {
      if (input.runId && (workerSetupPending || workspaceSyncPendingRunIds.includes(input.runId))) {
        items.push({
          kind: "notice",
          key: `pending-input:${input.id}:state`,
          timestamp: input.acceptedAt,
          text: t(
            workerSetupPending
              ? "chat.pendingInputs.waitingForWorkerSetup"
              : "chat.pendingInputs.waitingForWorkspaceSync",
          ),
        });
      }
      continue;
    }
    items.push({
      kind: "notice",
      key: `pending-input:${input.id}:state`,
      timestamp: input.acceptedAt,
      text: t(
        input.state === "interrupted" &&
          input.runId &&
          browserInputs.some(
            (item) =>
              item.sendRunId === input.runId &&
              item.sendState !== "failed" &&
              item.sendState !== "held",
          )
          ? "chat.pendingInputs.resuming"
          : input.state === "cancelled"
            ? "chat.pendingInputs.cancelled"
            : "chat.pendingInputs.interrupted",
      ),
    });
  }
  return items;
}

export function getChatPendingInputs(state: ChatState): PendingInputView | undefined {
  const view = pendingInputViews.get(state);
  return view?.sessionKey === state.sessionKey &&
    view.sessionId === (state.currentSessionId ?? null) &&
    view.agentId === resolveUiSelectedSessionAgentId(state)
    ? view
    : undefined;
}

export function clearChatPendingInputs(state: ChatState): void {
  pendingInputViews.delete(state);
}

export function readChatInputRunIds(state: ChatState): string[] {
  const projection = getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, { agentId: resolveUiSelectedSessionAgentId(state) }),
  );
  const runIds = [
    ...(getChatPendingInputs(state)?.queuedInputs.map((input) => input.runId) ?? []),
    ...projection.entries
      .filter((entry) => entry.pending && entry.identity?.role === "user")
      .map((entry) => entry.pendingRunId),
    ...state.chatQueue
      .filter((item) => (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed")
      .map((item) => item.sendRunId),
  ];
  return [
    ...new Set(
      runIds.filter((id): id is string => Boolean(id && id.length <= CHAT_INPUT_RUN_ID_MAX_CHARS)),
    ),
  ]
    .slice(0, CHAT_INPUT_RECEIPT_MAX_RUN_IDS)
    .toSorted();
}

function reconcilePendingInputPage(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  receipts?: ChatInputReceipts,
): ChatPendingInputsPage {
  const { page: displayPage, acceptedRunIds } = reconcileChatInputCustody(state, page, receipts);
  const settled = new Set([
    ...(receipts ?? [])
      .filter((receipt) => receipt.state === "consumed")
      .map((receipt) => receipt.runId),
    ...displayPage.items.filter((input) => input.state === "cancelled").map((input) => input.runId),
  ]);
  // Acceptance keeps the browser's authenticated retry payload. Only consumption
  // or explicit cancellation retires it; a restart may need a fresh admission.
  for (const item of state.chatQueue) {
    const canonical = findChatSubmissionMessage(state.chatMessages, item.sendRunId, true);
    if (
      item.sendRunId &&
      (settled.has(item.sendRunId) ||
        (canonical && (canonical.id !== null || canonical.sequence !== null))) &&
      (!item.sessionId || item.sessionId === state.currentSessionId)
    ) {
      removeQueuedMessage(state, item.id);
    } else if (
      item.sendRunId &&
      acceptedRunIds.has(item.sendRunId) &&
      (!item.sessionId || item.sendState === "unconfirmed")
    ) {
      confirmQueuedMessageCustody(state, item, state.currentSessionId ?? undefined);
    }
  }
  return displayPage;
}

function ownsPendingInputRequest(
  state: ChatState,
  view: PendingInputView,
  request: PendingInputRequest,
): boolean {
  return (
    getChatPendingInputs(state) === view &&
    view.request === request &&
    state.client === request.client &&
    state.connected &&
    state.connectionEpoch === request.connectionEpoch
  );
}

export function applyChatPendingInputs(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  options: { receipts?: ChatInputReceipts } = {},
): void {
  const displayPage = reconcilePendingInputPage(state, page, options.receipts);
  let view = getChatPendingInputs(state);
  const queuedInputs = reconcileQueuedInputs(
    view?.queuedInputs ?? [],
    displayPage,
    options.receipts,
  );
  if (!view) {
    view = {
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId ?? null,
      agentId: resolveUiSelectedSessionAgentId(state),
      page: displayPage,
      queuedInputs,
      revision: 0,
      get loading() {
        return this.request?.kind === "navigation";
      },
    };
    pendingInputViews.set(state, view);
  } else {
    view.queuedInputs = queuedInputs;
    view.revision += 1;
    if (view.request && !ownsPendingInputRequest(state, view, view.request)) {
      view.request = undefined;
    }
    if (view.before === undefined) {
      view.page = displayPage;
      view.error = undefined;
    }
    // Latest custody updates ownership immediately, but cannot take over browsing.
    if (view.before !== undefined && !view.request) {
      void requestPendingInputPage(state, view.before, "refresh");
    }
  }
  state.requestUpdate?.();
}

async function requestPendingInputPage(
  state: ChatState,
  before: number | undefined,
  kind: PendingInputRequest["kind"],
): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  if (!view || !client || !state.connected) {
    return;
  }
  if (
    view.request &&
    ownsPendingInputRequest(state, view, view.request) &&
    (kind === "refresh" || view.request.kind === "navigation")
  ) {
    return;
  }
  const request = { before, kind, client, connectionEpoch: state.connectionEpoch };
  view.request = request;
  view.error = undefined;
  if (kind === "navigation") {
    state.requestUpdate?.();
  }
  const current = () => ownsPendingInputRequest(state, view, request);
  try {
    while (current()) {
      const revision = view.revision;
      const result = await client.request<{
        sessionId?: string;
        pendingInputs?: ChatPendingInputsPage;
        inputReceipts?: ChatInputReceipts;
      }>("chat.history", {
        sessionKey: view.sessionKey,
        agentId: view.agentId,
        limit: 20,
        ...(view.queuedInputs.length ? { inputRunIds: readChatInputRunIds(state) } : {}),
        ...(request.before === undefined ? {} : { pendingBefore: request.before }),
      });
      if (!current() || result.sessionId !== view.sessionId) {
        return;
      }
      // Coalesce newer custody publications into a fresh read of the same target.
      if (view.revision !== revision) {
        continue;
      }
      view.page = reconcilePendingInputPage(state, result.pendingInputs, result.inputReceipts);
      view.queuedInputs = reconcileQueuedInputs(view.queuedInputs, view.page, result.inputReceipts);
      view.before = request.before;
      return;
    }
  } catch (error) {
    if (current()) {
      view.error = formatUiError(error);
    }
  } finally {
    if (view.request === request) {
      view.request = undefined;
      if (getChatPendingInputs(state) === view) {
        state.requestUpdate?.();
      }
    }
  }
}

export function loadChatPendingInputs(state: ChatState, before?: number): Promise<void> {
  return requestPendingInputPage(state, before, "navigation");
}
