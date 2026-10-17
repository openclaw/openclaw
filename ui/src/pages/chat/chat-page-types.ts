import type { ApplicationContext } from "../../app/context.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

export type ChatPageProps = {
  data: SessionChatRouteData;
  navDrawerOpen: boolean;
  presented: boolean;
  context?: ApplicationContext;
};
export type ChatPageHost = SolidBridgeElement<ChatPageProps>;
