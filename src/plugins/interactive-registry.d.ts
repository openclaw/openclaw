import { type RegisteredInteractiveHandler } from "./interactive-state.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";
export type InteractiveRegistrationResult = {
    ok: boolean;
    error?: string;
};
export declare function resolvePluginInteractiveNamespaceMatch(channel: string, data: string): {
    registration: RegisteredInteractiveHandler;
    namespace: string;
    payload: string;
} | null;
export declare function registerPluginInteractiveHandler(pluginId: string, registration: PluginInteractiveHandlerRegistration, opts?: {
    pluginName?: string;
    pluginRoot?: string;
}): InteractiveRegistrationResult;
export declare function clearPluginInteractiveHandlers(): void;
export declare function clearPluginInteractiveHandlerRegistrations(): void;
export declare function clearPluginInteractiveHandlersForPlugin(pluginId: string): void;
export declare function listPluginInteractiveHandlers(): RegisteredInteractiveHandler[];
export declare function restorePluginInteractiveHandlers(registrations: readonly RegisteredInteractiveHandler[]): void;
