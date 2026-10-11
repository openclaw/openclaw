import { createEffect, createMemo, onSettled, untrack } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { useSolidControllerHost } from "../lit/solid-controller-host.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
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
import "../pages/custodian/custodian-surface.ts";
import "./home-session.runtime.ts";
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
};
export type OpenClawAssistantPanelContent = SolidBridgeElement<Props>;
export const AssistantPanelContent = defineSolidBridge<Props>(
  "openclaw-assistant-panel-content",
  (props, element): SolidJSX.Element => {
    const { host, revision } = useSolidControllerHost(() => [props.store, props.context]);
    const store = () => props.store ?? custodianSessionStore;
    new SubscriptionsController(host)
      .watchStore(store)
      .watch(
        () => props.context,
        (context, notify) => subscribeChatWorkContext(context, notify),
      )
      .watchStore(() => props.context?.sessions)
      .watchStore(() => props.context?.agents)
      .watchStore(() => props.context?.gateway);
    onSettled(() => {
      element.dispatchEvent(
        new CustomEvent("assistant-custodian-store", { detail: untrack(store), bubbles: true }),
      );
    });
    createEffect(
      () => props.active && props.destination === "custodian",
      (visible) => {
        if (visible) {
          void untrack(store).refreshTranscriptIfIdle();
        }
      },
    );
    const variant = () => {
      revision();
      return store().activeVariant;
    };
    const workContext = createMemo(() => {
      revision();
      return (
        props.sessionContext ??
        (props.context
          ? buildHomeWorkContext(
              props.context,
              props.pageRouteId,
              props.pageSessionKey,
              props.pageAgentId,
            )
          : undefined)
      );
    });
    return (
      <>
        {props.active ? (
          props.destination !== "custodian" ? (
            <openclaw-home-session
              prop:sessionKey={props.sessionKey}
              prop:agentId={props.agentId}
              prop:workContext={workContext()}
            />
          ) : (
            <openclaw-custodian-surface
              prop:store={store()}
              prop:onboarding={variant() === "onboarding"}
              prop:newAgentIntent={variant() === "new-agent"}
            />
          )
        ) : undefined}
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
        "onAssistant-custodian-store"?: EventHandlerUnion<
          OpenClawAssistantPanelContent,
          CustomEvent<CustodianSessionStore>
        >;
      };
      "openclaw-home-session": AssistantElementAttributes<"openclaw-home-session"> & {
        "prop:workContext"?: ChatWorkContext;
      };
      "openclaw-custodian-surface": AssistantElementAttributes<"openclaw-custodian-surface"> & {
        "prop:store"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["store"];
        "prop:historyContent"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["historyContent"];
        "prop:onRetryChannelOnboarding"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["onRetryChannelOnboarding"];
      };
    }
  }
}
