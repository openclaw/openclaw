import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsDismissResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueDisplayItem } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import type { ChatPendingInputView, PendingInputRequest } from "./chat-pending-inputs.types.ts";
import {
  readDeliveredQueuedChatSendForRun,
  removeDeliveredQueuedChatSendForRun,
  removeQueuedMessage,
} from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reconcileChatInputCustody,
} from "./history-merge.ts";
import type { PendingInputStatus } from "./system-notice-kinds.ts";

function reconcileQueuedInputs(
  queued: ChatPendingInputsPage["items"],
  page: ChatPendingInputsPage,
  receipts?: ChatInputReceipts,
  queriedRunIds: readonly string[] = [],
): ChatPendingInputsPage["items"] {
  if (page.queuedCount === 0) {
    return [];
  }
  const completePage = page.nextBefore === undefined && page.items.length === page.total;
  const observed = new Map(receipts?.map((receipt) => [receipt.runId, receipt]));
  const queried = new Set(receipts === undefined ? [] : queriedRunIds);
  const current = new Map((completePage ? [] : queued).map((input) => [input.id, input]));
  for (const input of page.items) {
    if (input.queued) {
      current.set(input.id, input);
    } else {
      current.delete(input.id);
    }
  }
  // Ordinary consumption deletes custody. An exact queried absence retires its
  // queue projection even when the transcript has advanced beyond that message.
  return [...current.values()].filter((input) => {
    const receipt = input.runId ? observed.get(input.runId) : undefined;
    return receipt
      ? receipt.state === "pending" && receipt.queued
      : !input.runId || !queried.has(input.runId);
  });
}

function describePendingInputMessage(message: unknown): string {
  const normalized = normalizeMessage(message);
  const attachmentLabels = normalized.content.flatMap((part) =>
    part.type === "attachment" || part.type === "attachment_error"
      ? [part.attachment.label]
      : part.type === "image"
        ? part.sources.flatMap((source) => (source.fileName ? [source.fileName] : []))
        : [],
  );
  const imageCount = normalized.content.filter((part) => part.type === "image").length;
  return (
    extractText(message) ||
    attachmentLabels.join(", ") ||
    (imageCount ? t("chat.queue.imageCount", { count: String(imageCount) }) : "")
  );
}

export function buildPendingInputQueueItems(
  inputs: ChatPendingInputsPage["items"],
): ChatQueueDisplayItem[] {
  return inputs
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
    .filter((input) => input.queued && input.state === "queued" && input.runId)
    .map<ChatQueueDisplayItem>((input) => ({
      id: `pending-input:${input.id}`,
      text: describePendingInputMessage(input.message),
      createdAt: input.acceptedAt,
      pendingRunId: input.runId,
      serverQueued: true,
      sender: normalizeMessage(input.message).sender ?? undefined,
    }));
}

const PENDING_INPUT_PREVIEW_MAX_CHARS = 60;

function describePendingInputPreview(message: unknown): string {
  const compact = describePendingInputMessage(message).replace(/\s+/gu, " ").trim();
  if (!compact) {
    return t("chat.pendingInputs.untitledInput");
  }
  return compact.length > PENDING_INPUT_PREVIEW_MAX_CHARS
    ? `${truncateUtf16Safe(compact, PENDING_INPUT_PREVIEW_MAX_CHARS - 1)}…`
    : compact;
}

function isDismissablePendingInput(input: ChatPendingInputsPage["items"][number]): boolean {
  return (
    !input.queued &&
    !(input.state === "cancelled" && input.cancelledByUser) &&
    (input.state === "interrupted" || input.state === "cancelled") &&
    asNullableRecord(input.message)?.display !== false
  );
}

export function isPendingInputDismissHidden(view: ChatPendingInputView, id: string): boolean {
  return Boolean(view.dismissing?.has(id) || view.dismissed?.has(id));
}

export function buildPendingInputItems(
  inputs: ChatPendingInputsPage["items"],
  workspaceSyncPendingRunIds: readonly string[] = [],
  workerSetupPending = false,
): ChatItem[] {
  // Custody records stay outside active-run ordering until the writer promotes them.
  const items: ChatItem[] = [];
  for (const input of inputs) {
    let pendingStatus: PendingInputStatus =
      input.state === "queued" || input.state === "cancelled" ? input.state : "interrupted";
    if (
      input.state === "queued" &&
      input.runId &&
      (workerSetupPending || workspaceSyncPendingRunIds.includes(input.runId))
    ) {
      pendingStatus = workerSetupPending ? "waitingForWorkerSetup" : "waitingForWorkspaceSync";
    }
    const retired = isDismissablePendingInput(input)
      ? {
          id: input.id,
          status: input.state === "interrupted" ? ("interrupted" as const) : ("cancelled" as const),
          preview: describePendingInputPreview(input.message),
        }
      : undefined;
    // Custody keeps submission correlation outside the message; use it for
    // presentation without inventing transcript or execution identity.
    items.push(
      ...buildMessageItems([input.message], () =>
        input.runId ? `send:${input.runId}` : `pending-input:${input.id}`,
      ).flatMap((item) =>
        projectChatSystemNotice({ ...item, startsTurn: true }, undefined, {
          status: pendingStatus,
          key: `pending-input:${input.id}:state`,
          timestamp: input.acceptedAt,
          ...(input.cancelledByUser ? { cancelledByUser: true } : {}),
          ...(retired ? { retired } : {}),
        }),
      ),
    );
  }
  return items;
}

export function getChatPendingInputs(state: ChatState): ChatPendingInputView | undefined {
  const view = state.chatPendingInputs;
  return view?.sessionKey === state.sessionKey &&
    view.sessionId === (state.currentSessionId ?? null) &&
    view.agentId === resolveUiSelectedSessionAgentId(state)
    ? view
    : undefined;
}

export function clearChatPendingInputs(state: ChatState): void {
  state.chatPendingInputs = undefined;
}

function collectChatInputRunIds(state: ChatState): string[] {
  const projection = getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, { agentId: resolveUiSelectedSessionAgentId(state) }),
  );
  const runIds = [
    ...(getChatPendingInputs(state)?.queuedInputs.map((input) => input.runId) ?? []),
    ...projection.entries
      .filter((entry) => entry.pending && entry.identity?.role === "user")
      .map((entry) => entry.pendingRunId),
    ...state.chatQueue.filter((item) => (item.sendAttempts ?? 0) > 0).map((item) => item.sendRunId),
  ];
  const current = new Set(
    runIds.filter((id): id is string => Boolean(id && id.length <= CHAT_INPUT_RUN_ID_MAX_CHARS)),
  );
  return [
    ...new Set([
      ...(getChatPendingInputs(state)?.receiptRunIds.filter((id) => current.has(id)) ?? []),
      ...current,
    ]),
  ];
}

export function readChatInputRunIds(state: ChatState): string[] {
  return collectChatInputRunIds(state).slice(0, CHAT_INPUT_RECEIPT_MAX_RUN_IDS).toSorted();
}

function rotateInputReceipts(
  state: ChatState,
  view: ChatPendingInputView,
  queriedRunIds: readonly string[] = [],
): void {
  const observed = new Set(queriedRunIds);
  // Rotate across server, transcript, and browser custody without starving any source.
  view.receiptRunIds = collectChatInputRunIds(state).toSorted(
    (left, right) => Number(observed.has(left)) - Number(observed.has(right)),
  );
}

function reconcilePendingInputPage(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  receipts?: ChatInputReceipts,
): ChatPendingInputsPage {
  const { page: displayPage, acceptedRunIds } = reconcileChatInputCustody(state, page, receipts);
  const settled = new Set([
    ...(receipts ?? [])
      .filter(
        (receipt) =>
          receipt.state === "consumed" || (receipt.state === "pending" && receipt.cancelled),
      )
      .map((receipt) => receipt.runId),
    ...displayPage.items.filter((input) => input.state === "cancelled").map((input) => input.runId),
  ]);
  // Any positive custody receipt transfers retry ownership to the Gateway.
  for (const item of state.chatQueue) {
    const canonical = findChatSubmissionMessage(state.chatMessages, item.sendRunId, true);
    if (
      item.sendRunId &&
      (acceptedRunIds.has(item.sendRunId) ||
        settled.has(item.sendRunId) ||
        (canonical && (canonical.id !== null || canonical.sequence !== null))) &&
      (!item.sessionId || item.sessionId === state.currentSessionId)
    ) {
      removeQueuedMessage(state, item.id);
    }
  }
  return displayPage;
}

function ownsPendingInputRequest(
  state: ChatState,
  view: ChatPendingInputView,
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
  options: { receipts?: ChatInputReceipts; queriedRunIds?: readonly string[] } = {},
): void {
  const displayPage = reconcilePendingInputPage(state, page, options.receipts);
  let view = getChatPendingInputs(state);
  const queuedInputs = reconcileQueuedInputs(
    view?.queuedInputs ?? [],
    displayPage,
    options.receipts,
    options.queriedRunIds,
  );
  if (!view) {
    view = {
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId ?? null,
      agentId: resolveUiSelectedSessionAgentId(state),
      page: displayPage,
      queuedInputs,
      receiptRunIds: [],
      queuedCount: displayPage.queuedCount ?? 0,
      queueBefore: displayPage.nextBefore,
      get loading() {
        return this.request?.kind === "navigation";
      },
    };
    state.chatPendingInputs = view;
  } else {
    view.queuedInputs = queuedInputs;
    view.queuedCount = displayPage.queuedCount ?? 0;
    view.queueBefore = displayPage.nextBefore;
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
  rotateInputReceipts(state, view, options.queriedRunIds);
  if (
    !view.request &&
    view.queuedInputs.length < view.queuedCount &&
    view.queueBefore !== undefined
  ) {
    void requestPendingInputPage(state, view.queueBefore, "discovery");
  }
  chatRunPresentation(state).publish();
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
    (kind !== "navigation" || view.request.kind === "navigation")
  ) {
    return;
  }
  const request = { before, kind, client, connectionEpoch: state.connectionEpoch };
  view.request = request;
  view.error = undefined;
  if (kind === "navigation") {
    chatRunPresentation(state).publish();
  }
  const current = () => ownsPendingInputRequest(state, view, request);
  try {
    while (current()) {
      const inputRunIds = readChatInputRunIds(state);
      const result = await client.request<{
        sessionId?: string;
        pendingInputs?: ChatPendingInputsPage;
        inputReceipts?: ChatInputReceipts;
      }>("chat.history", {
        sessionKey: view.sessionKey,
        toolResultMaxChars: 2_000,
        agentId: view.agentId,
        limit: 20,
        ...(inputRunIds.length ? { inputRunIds } : {}),
        ...(request.before === undefined ? {} : { pendingBefore: request.before }),
      });
      if (!current() || result.sessionId !== view.sessionId) {
        return;
      }
      // An overlapping live update may leave this page briefly behind; the next
      // ordinary refresh catches it up without restarting navigation reads.
      const page = reconcilePendingInputPage(state, result.pendingInputs, result.inputReceipts);
      view.queuedInputs = reconcileQueuedInputs(
        view.queuedInputs,
        page,
        result.inputReceipts,
        inputRunIds,
      );
      view.queuedCount = page.queuedCount ?? view.queuedCount;
      rotateInputReceipts(state, view, inputRunIds);
      if (request.kind !== "discovery") {
        view.page = page;
        view.before = request.before;
      }
      if (request.kind === "discovery" || request.before === undefined) {
        view.queueBefore = page.nextBefore;
      }
      if (view.queuedInputs.length < view.queuedCount && view.queueBefore !== undefined) {
        request.kind = "discovery";
        request.before = view.queueBefore;
        continue;
      }
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
        chatRunPresentation(state).publish();
      }
    }
  }
}

export function loadChatPendingInputs(state: ChatState, before?: number): Promise<void> {
  return requestPendingInputPage(state, before, "navigation");
}

/** Retired inputs on the displayed page that are not already being dismissed. */
export function listDismissablePendingInputs(
  view: ChatPendingInputView,
): ChatPendingInputsPage["items"] {
  return view.page.items.filter(
    (input) => isDismissablePendingInput(input) && !isPendingInputDismissHidden(view, input.id),
  );
}

/** Hide the selected retired inputs at once, then keep or restore them by the Gateway outcome. */
export async function dismissChatPendingInputs(
  state: ChatState,
  inputIds: readonly string[],
): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  const sessionId = view?.sessionId;
  if (!view || !sessionId || !client || !state.connected || !inputIds.length) {
    return;
  }
  const owner = {};
  const connectionIsCurrent = captureChatConnectionOwner(state, false);
  const current = () => getChatPendingInputs(state) === view && connectionIsCurrent();
  view.dismissing = new Map([
    ...(view.dismissing ?? []),
    ...inputIds.map((id) => [id, owner] as const),
  ]);
  view.error = undefined;
  chatRunPresentation(state).publish();
  try {
    const result = await client.request<ChatPendingInputsDismissResult>(
      "chat.pendingInputs.dismiss",
      {
        sessionKey: view.sessionKey,
        ...(view.agentId ? { agentId: view.agentId } : {}),
        sessionId,
        inputIds: [...inputIds],
      },
    );
    // Route changes retain this connection's custody; a replacement Gateway owns its own copies.
    if (connectionIsCurrent()) {
      const scope = { sessionKey: view.sessionKey, agentId: view.agentId };
      for (const runId of result.runIds) {
        const copy = readDeliveredQueuedChatSendForRun(state, runId, scope);
        if (copy && (!copy.sessionId || copy.sessionId === sessionId)) {
          removeDeliveredQueuedChatSendForRun(state, runId, scope);
        }
      }
    }
    if (!current()) {
      return;
    }
    view.dismissed = new Set([
      ...(view.dismissed ?? []),
      ...result.dismissedIds,
      ...result.missingIds,
    ]);
    void requestPendingInputPage(state, view.before, "refresh");
  } catch (error) {
    if (current()) {
      view.error = formatUiError(error);
    }
  } finally {
    if (getChatPendingInputs(state) === view) {
      view.dismissing = new Map(
        [...(view.dismissing ?? [])].filter(([, request]) => request !== owner),
      );
      chatRunPresentation(state).publish();
    }
  }
}
