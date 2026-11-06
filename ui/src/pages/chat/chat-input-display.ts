import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

// History arrays are replaced, never mutated; index each once, not per scroll render.
const userIdentities = new WeakMap<
  readonly unknown[],
  { userIds: Set<string>; sendKeys: Set<string>; steerSendKeys: Set<string> }
>();

/** Custody is separate from history; dispatched steers retain their live display. */
export function selectChatInputDisplay(
  messages: readonly unknown[],
  queue: readonly ChatQueueItem[],
  inputs: ChatPendingInputsPage["items"],
) {
  let identities = userIdentities.get(messages);
  if (!identities) {
    identities = { userIds: new Set(), sendKeys: new Set(), steerSendKeys: new Set() };
    for (const message of messages) {
      const identity = readSessionMessageIdentity(message);
      if (identity?.role === "user") {
        if (identity.id) {
          identities.userIds.add(identity.id);
        }
        if (identity.idempotencyKey) {
          identities.sendKeys.add(identity.idempotencyKey);
          if (persistedSteerTargetRunId(message)) {
            identities.steerSendKeys.add(identity.idempotencyKey);
          }
        }
      }
    }
    userIdentities.set(messages, identities);
  }
  const { userIds, sendKeys, steerSendKeys } = identities;
  const accepted = new Set(inputs.map((input) => input.runId));
  const retainedSteer = (runId: string | undefined) =>
    Boolean(runId && (steerSendKeys.has(runId) || steerSendKeys.has(`${runId}:user`)));
  const unseenInputs = inputs.filter(
    (input) => !userIds.has(input.id) && !retainedSteer(input.runId),
  );
  return {
    queue: queue.filter(
      (item) =>
        !item.sendRunId ||
        (!accepted.has(item.sendRunId) &&
          !sendKeys.has(item.sendRunId) &&
          !sendKeys.has(`${item.sendRunId}:user`)),
    ),
    pendingInputs: unseenInputs.filter(
      (input) => !input.queued && asNullableRecord(input.message)?.display !== false,
    ),
    queuedInputs: unseenInputs.filter((input) => input.queued),
  };
}
