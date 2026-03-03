import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";
export function registerBrowserRoutes(app, ctx) {
    registerBrowserBasicRoutes(app, ctx);
    registerBrowserTabRoutes(app, ctx);
    registerBrowserAgentRoutes(app, ctx);
}
