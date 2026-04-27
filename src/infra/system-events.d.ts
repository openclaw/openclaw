import type { DeliveryContext } from "../utils/delivery-context.types.js";
export type SystemEvent = {
    text: string;
    ts: number;
    contextKey?: string | null;
    deliveryContext?: DeliveryContext;
    trusted?: boolean;
};
type SystemEventOptions = {
    sessionKey: string;
    contextKey?: string | null;
    deliveryContext?: DeliveryContext;
    trusted?: boolean;
};
export declare function isSystemEventContextChanged(sessionKey: string, contextKey?: string | null): boolean;
export declare function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean;
export declare function drainSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function consumeSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
export declare function drainSystemEvents(sessionKey: string): string[];
export declare function peekSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function peekSystemEvents(sessionKey: string): string[];
export declare function hasSystemEvents(sessionKey: string): boolean;
export declare function resolveSystemEventDeliveryContext(events: readonly SystemEvent[]): DeliveryContext | undefined;
export declare function resetSystemEventsForTest(): void;
export {};
