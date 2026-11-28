import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { isQueuedSendInlineState } from "../chat-progress.ts";
import { isSteerableQueuedMessage } from "../chat-queue.ts";

export function describeComposerQueueStatus(
  props: {
    queue: readonly ChatQueueItem[];
    connected?: boolean;
    offline?: boolean;
    runActive?: boolean;
    queuePaused?: boolean;
    queuedEdit?: { editingId?: string | null };
  },
  visibleQueue: () => readonly ChatQueueItem[],
) {
  const head = props.queue.find((item) => item.sendState !== "failed" || item.localCommandName);
  if (head?.sendState === "held" && isQueuedSendInlineState(head)) {
    return { label: t("chat.queue.states.blockedByReview"), tone: "warn" };
  }
  if (props.queuePaused) {
    return { label: t("chat.queue.states.pausedByStop"), tone: "paused" };
  }
  if (!props.offline && visibleQueue().some((item) => item.sendState === "waiting-model")) {
    return { label: t("chat.queue.states.applyingSettings"), tone: "settings" };
  }
  if (
    props.connected &&
    props.runActive &&
    head &&
    head.id !== props.queuedEdit?.editingId &&
    isSteerableQueuedMessage(head)
  ) {
    return { label: t("chat.queue.states.waitingForTurn"), tone: "waiting" };
  }
  return null;
}
