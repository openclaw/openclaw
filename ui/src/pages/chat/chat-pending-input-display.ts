import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { readPersistedMediaFacts } from "../../../../src/media/media-facts.js";
import type { ChatItem, ChatQueueDisplayItem } from "../../lib/chat/chat-types.ts";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { buildMessageItems } from "./chat-thread-item-identity.ts";
import type { PendingInputStatus } from "./system-notice-kinds.ts";

type PendingInputPreparation = {
  t: (key: string, params?: Record<string, string>) => string;
  describeChatQueueAttachmentLabels: typeof import("./chat-send-presentation.ts").describeChatQueueAttachmentLabels;
  projectChatSystemNotice: typeof import("./chat-system-notice.ts").projectChatSystemNotice;
};

function describePendingInputMessage(
  message: unknown,
  preparation: PendingInputPreparation,
): string {
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
    preparation.describeChatQueueAttachmentLabels(attachmentLabels) ||
    preparation.describeChatQueueAttachmentLabels(
      (readPersistedMediaFacts(asNullableRecord(message) ?? {}) ?? []).map(
        ({ fileName }) => fileName,
      ),
      imageCount,
    )
  );
}

export function preparePendingInputQueueItems(
  inputs: ChatPendingInputsPage["items"],
  preparation: PendingInputPreparation,
): ChatQueueDisplayItem[] {
  return inputs
    .filter((input) => input.queued && input.state === "queued" && input.runId)
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
    .map<ChatQueueDisplayItem>((input) => ({
      id: `pending-input:${input.id}`,
      text: describePendingInputMessage(input.message, preparation),
      createdAt: input.acceptedAt,
      pendingRunId: input.runId,
      serverQueued: true,
      sender: normalizeMessage(input.message).sender ?? undefined,
    }));
}

const PENDING_INPUT_PREVIEW_MAX_CHARS = 60;

function describePendingInputPreview(
  message: unknown,
  preparation: PendingInputPreparation,
): string {
  const compact = describePendingInputMessage(message, preparation).replace(/\s+/gu, " ").trim();
  if (!compact) {
    return preparation.t("chat.pendingInputs.untitledInput");
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

export function preparePendingInputItems(
  inputs: ChatPendingInputsPage["items"],
  preparation: PendingInputPreparation,
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
          preview: describePendingInputPreview(input.message, preparation),
        }
      : undefined;
    // Custody keeps submission correlation outside the message; use it for
    // presentation without inventing transcript or execution identity.
    items.push(
      ...buildMessageItems([input.message], () =>
        input.runId ? `send:${input.runId}` : `pending-input:${input.id}`,
      ).flatMap((item) =>
        preparation.projectChatSystemNotice({ ...item, startsTurn: true }, undefined, {
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
