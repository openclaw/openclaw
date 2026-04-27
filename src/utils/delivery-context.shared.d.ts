import type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
export declare function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined;
export declare function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
    deliveryContext?: DeliveryContext;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
};
export declare function deliveryContextFromSession(entry?: DeliveryContextSessionSource): DeliveryContext | undefined;
export declare function mergeDeliveryContext(primary?: DeliveryContext, fallback?: DeliveryContext): DeliveryContext | undefined;
export declare function deliveryContextKey(context?: DeliveryContext): string | undefined;
