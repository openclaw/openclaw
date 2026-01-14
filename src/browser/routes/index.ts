import type express from "express";

import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";

export function registerBrowserRoutes(app: express.Express, ctx: BrowserRouteContext) {
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserAgentRoutes(app, ctx);
}
