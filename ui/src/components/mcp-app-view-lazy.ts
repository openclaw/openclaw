import { lazy } from "solid-js";

export const McpAppView = lazy(() => import("./mcp-app-view.tsx"), {
  export: "McpAppView",
});
