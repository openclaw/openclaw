/** Test-only durable channel ingress state helpers. */
import {
  createChannelIngressQueue,
  type ChannelIngressQueue,
  type CreateChannelIngressQueueOptions,
} from "../channels/message/ingress-queue.js";

// Plugin fixtures use the public queue contract, excluding core operator operations.
export const createChannelIngressQueueForTests: <
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressQueueOptions,
  assertCurrent?: () => void,
) => ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> = createChannelIngressQueue;

export { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
export {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
export { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
export { listChannelIngressQueueAccountIdsReadOnly as listChannelIngressQueueAccountIdsForTests } from "../channels/message/ingress-queue.js";
export { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
export { observeChannelIngressQueueWrite } from "../channels/message/ingress-drain.test-helpers.js";
export { withRegisteredChannelIngress } from "./test-helpers/registered-channel-ingress.js";
