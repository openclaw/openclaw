import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentDebugRoutes } from "./agent.debug.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
export function registerBrowserAgentRoutes(app, ctx) {
    registerBrowserAgentSnapshotRoutes(app, ctx);
    registerBrowserAgentActRoutes(app, ctx);
    registerBrowserAgentDebugRoutes(app, ctx);
    registerBrowserAgentStorageRoutes(app, ctx);
}
