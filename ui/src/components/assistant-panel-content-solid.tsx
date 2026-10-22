import { createMemo, onSettled } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  buildHomeWorkContext,
  subscribeChatWorkContext,
  type ChatWorkContext,
} from "../pages/chat/chat-work-context.ts";
import {
  custodianSessionStore,
  type CustodianSessionStore,
} from "../pages/custodian/custodian-session-store.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import "../pages/custodian/custodian-surface.tsx";
import { HomeSession } from "./home-session-solid.tsx";
import "../styles/assistant-panel-content.css";

type Props = {
  active: boolean;
  destination: "home" | "custodian" | "session";
  sessionKey: string;
  agentId: string;
  sessionContext?: ChatWorkContext;
  context?: ApplicationContext;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  store?: CustodianSessionStore;
  onStore?: (store: CustodianSessionStore) => void;
};
export type OpenClawAssistantPanelContent = SolidBridgeElement<Props>;

function ActiveCustodian(props: {
  store: CustodianSessionStore;
  variant: CustodianSessionStore["activeVariant"];
}) {
  onSettled(() => {
    void props.store.refreshTranscriptIfIdle();
  });
  return (
    <openclaw-custodian-surface
      prop:store={props.store}
      prop:onboarding={props.variant === "onboarding"}
      prop:newAgentIntent={props.variant === "new-agent"}
    />
  );
}

export const AssistantPanelContent = defineSolidBridge<Props>(
  "openclaw-assistant-panel-content",
  (props): SolidJSX.Element => {
    const store = () => props.store ?? custodianSessionStore;
    const projection = createMemo(() =>
      projectSource(
        { store: store(), context: props.context },
        {
          read: (source) => source,
          subscribe: (source, notify) => {
            const stops = [
              source.store.subscribe(notify),
              source.context && subscribeChatWorkContext(source.context, notify),
              source.context?.sessions.subscribe(notify),
              source.context?.agents.subscribe(notify),
              source.context?.gateway.subscribe(notify),
            ];
            return () => stops.forEach((stop) => stop?.());
          },
          equality: "revision",
        },
      ),
    );
    onSettled(() => props.onStore?.(store()));
    const variant = () => projection().read().store.activeVariant;
    const workContext = createMemo(() => {
      const current = projection().read().context;
      return (
        props.sessionContext ??
        (current &&
          buildHomeWorkContext(current, props.pageRouteId, props.pageSessionKey, props.pageAgentId))
      );
    });
    return (
      <>
        {props.active &&
          (props.destination !== "custodian" ? (
            <HomeSession
              sessionKey={props.sessionKey}
              agentId={props.agentId}
              workContext={workContext()}
            />
          ) : (
            <ActiveCustodian store={store()} variant={variant()} />
          ))}
      </>
    );
  },
  {
    properties: {
      active: { default: false, type: Boolean },
      destination: { default: "custodian" },
      sessionKey: { default: "" },
      agentId: { default: "" },
      sessionContext: { default: undefined, attribute: false },
      context: { default: undefined, attribute: false },
      pageRouteId: { default: "chat" },
      pageSessionKey: { default: "" },
      pageAgentId: { default: "" },
      store: { default: undefined, attribute: false },
      onStore: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel-content": OpenClawAssistantPanelContent;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    type AssistantElementAttributes<Tag extends keyof HTMLElementTagNameMap> = HTMLAttributes<
      HTMLElementTagNameMap[Tag]
    > &
      Properties<HTMLElementTagNameMap[Tag]>;

    interface IntrinsicElements {
      "openclaw-assistant-panel-content": AssistantElementAttributes<"openclaw-assistant-panel-content"> & {
        "prop:sessionContext"?: Props["sessionContext"];
        "prop:context"?: Props["context"];
        "prop:store"?: Props["store"];
        "prop:onStore"?: Props["onStore"];
      };
      "openclaw-custodian-surface": AssistantElementAttributes<"openclaw-custodian-surface"> & {
        "prop:store"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["store"];
        "prop:historyContent"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["historyContent"];
        "prop:channelOnboardingContent"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["channelOnboardingContent"];
      };
    }
  }
}
