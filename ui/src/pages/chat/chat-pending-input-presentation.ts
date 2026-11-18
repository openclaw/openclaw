import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import {
  preparePendingInputItems,
  preparePendingInputQueueItems,
} from "./chat-pending-input-display.ts";
import { describeChatQueueAttachmentLabels } from "./chat-send-presentation.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";

const preparation = { t, describeChatQueueAttachmentLabels, projectChatSystemNotice };

export function buildPendingInputQueueItems(inputs: ChatPendingInputsPage["items"]) {
  return preparePendingInputQueueItems(inputs, preparation);
}

export function buildPendingInputItems(
  inputs: ChatPendingInputsPage["items"],
  workspaceSyncPendingRunIds: readonly string[] = [],
  workerSetupPending = false,
) {
  return preparePendingInputItems(
    inputs,
    preparation,
    workspaceSyncPendingRunIds,
    workerSetupPending,
  );
}
