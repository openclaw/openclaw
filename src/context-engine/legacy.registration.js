import { LegacyContextEngine } from "./legacy.js";
import { registerContextEngineForOwner } from "./registry.js";
export function registerLegacyContextEngine() {
    registerContextEngineForOwner("legacy", async () => new LegacyContextEngine(), "core", {
        allowSameOwnerRefresh: true,
    });
}
