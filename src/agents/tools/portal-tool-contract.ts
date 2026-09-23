import { Type } from "typebox";
import {
  PortalCloseResultSchema,
  PortalListResultSchema,
  PortalSummarySchema,
} from "../../../packages/gateway-protocol/src/schema/portals.js";

export const PORTAL_TOOL_DESCRIPTION =
  "Expose a local HTTP server or a conversation-attached environment's HTTP server (environmentId) through a portal route; verify browser access and app rendering in Control UI. Order matters: action=open with the port first, which returns the URL; then start the dev server as a background process on the same host, passing PORT and PUBLIC_URL from that result. Workspace may declare servers in .openclaw/portals.json. Proxies HTTP and WebSockets, so hot reload works; serves retry page until port listens. action=list and action=close manage portals. Use returned URLs unchanged; remote access requires private ingress or a reachable direct listener. Portals end at gateway restart.";

export const PortalToolSchema = Type.Object(
  {
    action: Type.String({ enum: ["open", "list", "close"], description: "Portal action" }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
    path: Type.Optional(Type.String({ pattern: "^/" })),
    id: Type.Optional(Type.String({ minLength: 1 })),
    environmentId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Conversation-attached environment returned by the environment tool; omit for the current execution host.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const PortalOutputSchema = Type.Union([
  PortalSummarySchema,
  PortalListResultSchema,
  PortalCloseResultSchema,
]);

export const SessionPortalToolSchema = Type.Omit(PortalToolSchema, ["environmentId"]);
export const SESSION_PORTAL_TOOL_DESCRIPTION =
  "Expose an HTTP development server on this conversation's attached dedicated worker through a portal. action=open allocates a route for the port; start the application on that worker using the returned PORT and PUBLIC_URL, then verify the returned URL in a browser. action=list and action=close manage only this attached worker's portals. URLs are bearer links: anyone holding one can access the application while the portal and environment remain active. Allocation does not prove remote reachability. Gateway-host and other machines' ports are unavailable.";
