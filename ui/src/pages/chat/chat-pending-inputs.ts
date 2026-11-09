import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
  CHAT_PENDING_INPUT_MESSAGE_PREFIX,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { readPersistedMediaFacts } from "../../../../src/media/media-facts.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueDisplayItem } from "../../lib/chat/chat-types.ts";
import {
  findChatSubmissionMessage,
  readChatThreadMessageIdentity,
} from "../../lib/chat/history-message-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import type {
  ChatPendingInputAction,
  ChatPendingInputView,
  PendingInputRequest,
} from "./chat-pending-inputs.types.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { describeChatQueueAttachmentLabels } from "./chat-send-presentation.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reconcileChatInputCustody,
} from "./history-merge.ts";
import type { PendingInputStatus } from "./system-notice-kinds.ts";

export function reconcileQueuedInputs(
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
  let imageCount = 0;
  const attachmentLabels = normalized.content.flatMap((part) => {
    if (part.type === "image") {
      imageCount += 1;
      return part.sources.map(({ fileName }) => fileName);
    }
    return part.type === "attachment" || part.type === "attachment_error"
      ? part.attachment.label
      : [];
  });
  return (
    extractText(message)?.trim() ||
    describeChatQueueAttachmentLabels(attachmentLabels) ||
    describeChatQueueAttachmentLabels(
      (readPersistedMediaFacts(asNullableRecord(message) ?? {}) ?? []).map(
        ({ fileName }) => fileName,
      ),
      imageCount,
    )
  );
}

export function buildPendingInputQueueItems(
  inputs: ChatPendingInputsPage["items"],
): ChatQueueDisplayItem[] {
  return inputs
    .filter((input) => input.queued && input.state === "queued" && input.runId)
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
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
    input.state === "cancelled" &&
    !input.cancelledByUser &&
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
    // Legacy interrupted custody is retained in storage but has no presentation.
    if (input.state !== "queued" && input.state !== "cancelled") {
      continue;
    }
    let pendingStatus: PendingInputStatus = input.state;
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
  const retained = getChatPendingInputs(state)?.receiptRunIds.filter((id) => current.delete(id));
  return [...(retained ?? []), ...current];
}

export function readChatInputRunIds(state: ChatState): string[] {
  return collectChatInputRunIds(state).slice(0, CHAT_INPUT_RECEIPT_MAX_RUN_IDS).toSorted();
}

export function rotateInputReceipts(
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

export function reconcilePendingInputPage(
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

export async function requestPendingInputPage(
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
    const { fetchPendingInputPage } = await import("./chat-pending-inputs.runtime.ts");
    await fetchPendingInputPage(state, view, request, current);
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

export async function mutateChatPendingInput(
  state: ChatState,
  action: ChatPendingInputAction,
): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  const sessionId = view?.sessionId;
  if (!view || !sessionId || !client || !state.connected) {
    return;
  }
  const connectionIsCurrent = captureChatConnectionOwner(state, false);
  const current = () => connectionIsCurrent() && getChatPendingInputs(state) === view;
  // Keep dismissal immediate while its mutation implementation loads on demand.
  if (action.kind === "dismiss") {
    (view.dismissing ??= new Map()).set(action.inputId, current);
    view.error = undefined;
    chatRunPresentation(state).publish();
  }
  try {
    const { executePendingInputAction } = await import("./chat-pending-inputs.runtime.ts");
    if (current()) {
      await executePendingInputAction(
        { state, view, client, sessionId, current, connectionIsCurrent },
        action,
      );
    }
  } catch (error) {
    if (!current()) {
      return;
    }
    if (action.kind === "steer") {
      // A refused Send now is not a user-facing error: the steer stays queued and
      // still reaches the next model turn. Refresh so its row shows current state.
      void requestPendingInputPage(state, view.before, "refresh");
    } else {
      view.error = formatUiError(error);
    }
  } finally {
    if (getChatPendingInputs(state) === view) {
      if (action.kind === "dismiss" && view.dismissing?.get(action.inputId) === current) {
        view.dismissing.delete(action.inputId);
      }
      chatRunPresentation(state).publish();
    }
  }
}

type PendingInput = ChatPendingInputsPage["items"][number];
/**
 * Steers waiting on one run drain together, so one row speaks for all of them:
 * Send now on the newest sendable steer, otherwise Steering… on the newest.
 */
type SteerRow = { newest?: true; sendNow?: true; deferToSendNow?: true };
export type PendingSteer = PendingInput & SteerRow;
// Stable copies keep transcript memo dependencies unchanged until a row moves.
const markedSteers = new WeakMap<PendingInput, PendingSteer>();

function markSteer(input: PendingInput, row: SteerRow): PendingSteer {
  const cached = markedSteers.get(input);
  if (
    cached &&
    cached.newest === row.newest &&
    cached.sendNow === row.sendNow &&
    cached.deferToSendNow === row.deferToSendNow
  ) {
    return cached;
  }
  const steer = { ...input, ...row };
  markedSteers.set(input, steer);
  return steer;
}

export function createPendingSteerLookup(inputs: ChatPendingInputsPage["items"] | undefined) {
  const pendingSteers = new Map<string, PendingSteer>();
  const steers = (inputs ?? []).filter((input) => input.steerNow && input.runId);
  const newer = (a: PendingInput | undefined, b: PendingInput) =>
    !a || b.acceptedAt >= a.acceptedAt ? b : a;
  const newest = steers.reduce<PendingInput | undefined>(newer, undefined);
  const sendable = steers
    .filter((input) => input.steerNow?.status === "available")
    .reduce<PendingInput | undefined>(newer, undefined);
  for (const input of steers) {
    const row: SteerRow = {
      ...(input === newest ? { newest: true } : {}),
      ...(input === sendable ? { sendNow: true } : {}),
      ...(input === newest && sendable && sendable !== input ? { deferToSendNow: true } : {}),
    };
    const steer = row.newest || row.sendNow ? markSteer(input, row) : input;
    pendingSteers.set(`${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}`, steer);
    if (input.runId) {
      pendingSteers.set(input.runId, steer);
    }
  }
  if (!pendingSteers.size) {
    return undefined;
  }
  return (message: unknown) => {
    const identity = readChatThreadMessageIdentity(message);
    return identity?.role === "user"
      ? pendingSteers.get(identity.sendId ?? identity.id ?? "")
      : undefined;
  };
}
