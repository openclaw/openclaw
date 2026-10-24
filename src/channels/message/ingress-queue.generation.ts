import type { ExpressionBuilder } from "kysely";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { ChannelIngressQueueRecordGeneration } from "./ingress-queue.types.js";

/**
 * Every transition writes an updated_at strictly past anything a reader could
 * have seen, even under a frozen or stepped-back clock, so (event_id,
 * updated_at) names one row generation. Generation-fenced writes rely on it.
 */
export const nextUpdatedAt = (
  eb: ExpressionBuilder<Pick<DB, "channel_ingress_events">, "channel_ingress_events">,
  now: number,
) => eb.fn<number>("max", [eb.val(now), eb("updated_at", "+", 1)]);

/** Fences a write to the row generation the caller inspected (see nextUpdatedAt). */
export type ChannelIngressGenerationFence = { generation?: ChannelIngressQueueRecordGeneration };
