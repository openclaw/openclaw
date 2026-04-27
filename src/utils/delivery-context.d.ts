export { deliveryContextFromSession, deliveryContextKey, mergeDeliveryContext, normalizeDeliveryContext, normalizeSessionDeliveryFields, } from "./delivery-context.shared.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
type ConversationTargetParams = {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
};
export declare function formatConversationTarget(params: ConversationTargetParams): string | undefined;
export declare function resolveConversationDeliveryTarget(params: {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
}): {
    to?: string;
    threadId?: string;
};
