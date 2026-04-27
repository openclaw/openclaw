import { listChannelPlugins } from "../channels/plugins/index.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";
import { createChannelOutboundRuntimeSend } from "./send-runtime/channel-outbound-send.js";
// Per-channel module caches for lazy loading.
const senderCache = new Map();
/**
 * Create a lazy-loading send function proxy for a channel.
 * The channel's module is loaded on first call and cached for reuse.
 */
function createLazySender(channelId, loader) {
    const loadRuntimeSend = createLazyRuntimeSurface(loader, ({ runtimeSend }) => runtimeSend);
    return async (...args) => {
        let cached = senderCache.get(channelId);
        if (!cached) {
            cached = loadRuntimeSend();
            senderCache.set(channelId, cached);
        }
        const runtimeSend = await cached;
        return await runtimeSend.sendMessage(...args);
    };
}
export function createDefaultDeps() {
    // Keep the default dependency barrel limited to lazy senders so callers that
    // only need outbound deps do not pull channel runtime boundaries on import.
    const deps = {};
    for (const plugin of listChannelPlugins()) {
        deps[plugin.id] = createLazySender(plugin.id, async () => ({
            runtimeSend: createChannelOutboundRuntimeSend({
                channelId: plugin.id,
                unavailableMessage: `${plugin.meta.label ?? plugin.id} outbound adapter is unavailable.`,
            }),
        }));
    }
    return deps;
}
export function createOutboundSendDeps(deps) {
    return createOutboundSendDepsFromCliSource(deps);
}
