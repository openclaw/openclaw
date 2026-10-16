import type { ApplicationContext } from "../../app/context.ts";
import type { ControllerHost } from "../../lib/subscriptions-controller.ts";
import type { SolidBridgeElement } from "../../lit/solid-bridge.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

export type ChatPageProps = {
  data: SessionChatRouteData;
  navDrawerOpen: boolean;
  presented: boolean;
  context?: ApplicationContext;
};
export type ChatPageMethods = {
  requestUpdate(): void;
  addController: ControllerHost["addController"];
  removeController: ControllerHost["removeController"];
};
export type ChatPageHost = SolidBridgeElement<ChatPageProps, ChatPageMethods>;
