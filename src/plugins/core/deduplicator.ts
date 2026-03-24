import { OpenClawConfig } from "../../config/config.js";

/**
 * Deduplicates the list of plugins to be loaded.
 * Prefers explicitly installed plugins over auto-discovered ones to prevent conflicts.
 * Addresses #53938.
 */
export function deduplicatePlugins(config: OpenClawConfig) {
    const installed = new Set(config.plugins?.installs?.map(p => p.id) || []);
    const entries = config.plugins?.entries || {};
    
    // Logic to filter entries that are already covered by installs
    const deduplicatedEntries = Object.fromEntries(
        Object.entries(entries).filter(([id]) => !installed.has(id))
    );

    return {
        ...config,
        plugins: {
            ...config.plugins,
            entries: deduplicatedEntries
        }
    };
}
