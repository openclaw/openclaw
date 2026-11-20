import { createMemo } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  buildHomeWorkContext,
  subscribeChatWorkContext,
  type ChatWorkContext,
} from "../pages/chat/chat-work-context.ts";
import { HomeSession } from "./home-session-solid.tsx";
import "../styles/assistant-panel-content.css";

type Props = {
  active: boolean;
  sessionKey: string;
  agentId: string;
  sessionContext?: ChatWorkContext;
  context?: ApplicationContext;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
};
export const AssistantPanelContent = defineSolidBridge<Props>(
  "openclaw-assistant-panel-content",
  (props) => {
    const projection = createMemo(() =>
      projectSource(
        { context: props.context },
        {
          read: (source) => source.context,
          subscribe: (source, notify) => {
            const context = source.context;
            const stops = [
              context && subscribeChatWorkContext(context, notify),
              context?.sessions.subscribe(notify),
              context?.agents.subscribe(notify),
              context?.gateway.subscribe(notify),
            ];
            return () => stops.forEach((stop) => stop?.());
          },
          equality: "revision",
        },
      ),
    );
    const workContext = createMemo(() => {
      const context = projection().read();
      return (
        props.sessionContext ??
        (context &&
          buildHomeWorkContext(context, props.pageRouteId, props.pageSessionKey, props.pageAgentId))
      );
    });
    return (
      <HomeSession
        active={props.active}
        sessionKey={props.sessionKey}
        agentId={props.agentId}
        workContext={workContext()}
      />
    );
  },
  {
    properties: {
      active: { default: false, type: Boolean },
      sessionKey: { default: "" },
      agentId: { default: "" },
      sessionContext: { default: undefined, attribute: false },
      context: { default: undefined, attribute: false },
      pageRouteId: { default: "chat" },
      pageSessionKey: { default: "" },
      pageAgentId: { default: "" },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel-content": SolidBridgeElement<Props>;
  }
}
