import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { SessionEventOptions, SessionEventTarget } from "./session-event-contract.js";
import { getSessionEventRuntimeConfig } from "./session-event-target.js";

type RouteReplyParams = Parameters<typeof import("./route-reply.js").routeReply>[0];
type SessionEventDeliveryParams = Pick<
  RouteReplyParams,
  | "cfg"
  | "agentId"
  | "sessionKey"
  | "payload"
  | "replyKind"
  | "abortSignal"
  | "beforeDeliver"
  | "assertCurrent"
>;

async function prepareSessionEventDelivery(
  route: DeliveryContext,
  assertCurrent: () => void,
): Promise<
  (params: SessionEventDeliveryParams) => ReturnType<typeof import("./route-reply.js").routeReply>
> {
  const { isRoutableChannel, routeReply, routePreparedReply } = await import("./route-reply.js");
  assertCurrent();
  if (!isRoutableChannel(route.channel) || !route.to) {
    throw new Error(
      "Session event has no original external delivery route; inspect the session result or choose a delivery destination",
    );
  }
  const { channel, to, accountId, threadId } = route;
  return async (params) => {
    const { payload, ...delivery } = params;
    const destination = { channel, to, accountId, threadId, mirror: false };
    if (params.replyKind !== "final") {
      return routeReply({ ...params, ...destination });
    }
    // Dispatch already applied final lane policy and normalized this payload.
    // Preserve admitted reasoning without enabling raw tool or block reasoning.
    const { createStructuredOutboundPayloadPlan } =
      await import("../../infra/outbound/payloads.js");
    const [plan] = createStructuredOutboundPayloadPlan([payload]);
    if (!plan) {
      return { ok: true, delivered: false, suppressed: true };
    }
    return routePreparedReply({ ...delivery, ...destination, plan });
  };
}

/** One delivery projection survives every callback of an admitted event attempt. */
export function createSessionEventReplyDelivery(params: {
  options: SessionEventOptions;
  agentId: string;
  sessionKey: string;
  signal: AbortSignal;
  target: () => SessionEventTarget | undefined;
  route: () => DeliveryContext | undefined;
  prepareCurrent: () => Promise<void>;
  assertCurrent: () => void;
  assertEffectCurrent: () => void;
  sourceReplyDelivered: () => boolean;
}) {
  const state: {
    delivered: boolean;
    deliveryAttempted: boolean;
    deliveryAmbiguous: boolean;
    deliveryError?: string;
    summary?: string;
    deliver: (payload: ReplyPayload, kind: "tool" | "block" | "final") => Promise<void>;
  } = {
    delivered: false,
    deliveryAttempted: false,
    deliveryAmbiguous: false,
    async deliver(payload, kind) {
      await params.prepareCurrent();
      if (kind === "final" && payload.text) {
        state.summary ??= truncateUtf16Safe(payload.text, 2000);
      }
      if (
        params.options.deliver === false ||
        params.target()?.deliver === false ||
        (params.options.suppressErrorDelivery && payload.isError === true) ||
        (kind === "final" && params.sourceReplyDelivered())
      ) {
        return;
      }
      const route = params.route();
      if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
        // Internal/WebChat transcript results are not evidence of a transport send.
        return;
      }
      const deliverReply = await prepareSessionEventDelivery(route, params.assertCurrent);
      state.deliveryAttempted = true;
      const assertDeliveryCurrent = () => {
        params.assertEffectCurrent();
        params.options.scheduledAutomation?.assertDeliveryCurrent?.();
      };
      const replyToId =
        params.options.source === "restart" ? params.options.restartReplyToId : undefined;
      // This anchor belongs to the original request, not the synthetic event or a model directive.
      const deliveryPayload = replyToId
        ? setReplyPayloadMetadata(
            copyReplyPayloadMetadata(payload, { ...payload, replyToId, replyToCurrent: undefined }),
            { replyToIdExplicit: true },
          )
        : payload;
      const result = await deliverReply({
        cfg: getSessionEventRuntimeConfig(),
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        payload: deliveryPayload,
        replyKind: kind,
        abortSignal: params.signal,
        beforeDeliver: async () => {
          await params.options.scheduledAutomation?.beforeDeliver?.();
          assertDeliveryCurrent();
        },
        assertCurrent: assertDeliveryCurrent,
      });
      state.delivered ||= result.delivered;
      state.deliveryAmbiguous ||= result.ambiguous === true;
      if (!result.ok) {
        if (!params.options.scheduledAutomation) {
          throw new Error(result.error ?? "Session event delivery failed");
        }
        // Cron records transport failure separately from completed agent work.
        state.deliveryError = result.error ?? "Session event delivery failed";
      }
    },
  };
  return state;
}
