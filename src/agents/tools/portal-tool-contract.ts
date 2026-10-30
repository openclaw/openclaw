import { Type } from "typebox";
import {
  PortalCloseResultSchema,
  PortalListResultSchema,
  PortalSummarySchema,
} from "../../../packages/gateway-protocol/src/schema/portals.js";

export const PORTAL_TOOL_DESCRIPTION =
  "Allocate a portal route for an HTTP app/dev server, not a file (attach media with MEDIA:<path>). Select the app's environmentId for an attached environment; omit it only for the current execution host. First action=open with the app port; then start the server in that same environment as a background process with the returned PORT and token-free PUBLIC_URL. Workspace servers may be declared in .openclaw/portals.json. HTTP and WebSockets are proxied; a waiting page appears until the app listens. Read exposure in open/list: loopback-only means local to the Gateway host, not remote viewer access; non-loopback still does not prove reachability. Local use is valid. Present through available Control UI capabilities and verify app rendering from the requesting viewer; a worker/Gateway browser test is not delivery proof. Keep returned URLs unchanged and bearer launch URLs private. action=list/close manage routes; portals end at Gateway restart.";

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

export const SessionPortalToolSchema = Type.Omit(PortalToolSchema, ["environmentId"], {
  additionalProperties: false,
});
export const SESSION_PORTAL_TOOL_DESCRIPTION =
  "Allocate a portal route for an HTTP app/dev server on this conversation's attached dedicated worker, not a file (attach media with MEDIA:<path>). First action=open with the app port; then start the server on that worker with the returned PORT and token-free PUBLIC_URL. action=list/close manage only this worker's portals; Gateway-host and other machines' ports are unavailable. Read exposure in open/list: loopback-only is local to the Gateway host, even though the app runs on a worker; non-loopback still does not prove viewer reachability. Local use is valid. Present through available Control UI capabilities and verify rendering from the requesting viewer, not just a worker/Gateway browser. Use returned URLs unchanged. Launch URLs are private bearer links: anyone holding one can access the application while its portal and environment remain active.";
