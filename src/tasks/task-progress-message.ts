import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type TaskProgressMessageRuntime = Pick<
  typeof import("./task-registry-delivery-runtime.js"),
  "sendMessage" | "editTaskProgressMessage"
>;

type ProgressSendParams = Parameters<TaskProgressMessageRuntime["sendMessage"]>[0] & {
  assertDirectAdapterHandoff: () => void;
};

export type TaskProgressMessageTarget = {
  channel: string;
  to: string;
  accountId: string;
  threadId?: string | number;
  messageId: string;
  /** Original host-owned requester facts, never reconstructed from the send receipt. */
  requesterOrigin: DeliveryContext;
};

/** Ephemeral presentation state, owned and bounded by the progress batch. */
export type TaskProgressMessageState = {
  attempted?: boolean;
  originKey?: string;
  target?: TaskProgressMessageTarget;
  content?: string;
  pending?: Promise<void>;
};

/** A failed or identityless first send must never create another progress message. */
export function sendOrEditTaskProgressMessage(
  state: TaskProgressMessageState,
  params: ProgressSendParams,
  runtime: TaskProgressMessageRuntime,
): Promise<void> {
  const publish = async () => {
    params.assertDirectAdapterHandoff();
    const originKey = JSON.stringify([
      params.channel,
      params.to,
      params.accountId,
      params.threadId,
      params.agentId,
    ]);
    if (state.attempted) {
      if (state.originKey !== originKey) {
        throw new Error("Background progress destination changed");
      }
      if (!state.target || state.content === params.content) {
        return;
      }
      await runtime.editTaskProgressMessage({
        ...state.target,
        content: params.content,
        agentId: params.agentId,
        assertCurrent: params.assertDirectAdapterHandoff,
      });
      state.content = params.content;
      return;
    }
    state.attempted = true;
    state.originKey = originKey;
    const requesterOrigin: DeliveryContext = {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
    };
    const sent = await runtime.sendMessage(params);
    const result = sent.result;
    if (
      sent.dryRun ||
      (sent.deliveryStatus !== undefined && sent.deliveryStatus !== "sent") ||
      !result?.messageId ||
      !params.accountId ||
      !("channel" in result) ||
      !result.target ||
      result.outcome === "not_sent" ||
      (result.receipt && result.receipt.platformMessageIds.length !== 1)
    ) {
      return;
    }
    // Receipt kinds describe platform destinations, not portable address prefixes.
    const destination = getChannelPlugin(sent.channel)?.messaging?.resolveDeliveryTarget?.({
      conversationId: result.target.id,
    }) ?? { to: `${result.target.kind}:${result.target.id}` };
    if (!destination.to) {
      return;
    }
    state.target = {
      channel: sent.channel,
      to: destination.to,
      accountId: params.accountId,
      threadId: result.receipt?.threadId ?? destination.threadId ?? params.threadId,
      messageId: result.messageId,
      requesterOrigin,
    };
    state.content = params.content;
  };
  // Serialize edits even when an event arrives during the initial platform send.
  const pending = (state.pending ?? Promise.resolve()).then(publish);
  state.pending = pending.catch(() => {});
  return pending;
}
