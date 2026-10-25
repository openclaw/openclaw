import type { JSX } from "@solidjs/web";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import type { ControlUiSurfaceProps } from "../../../src/plugin-sdk/control-ui.js";
import type { ClawHubRecommendation } from "../../../src/shared/clawhub-recommendations.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { LobsterPetProps } from "../components/lobster-pet-contract.ts";
import type { MascotMood } from "../components/mascot-pose.ts";
import type { MessageActionDetails } from "../pages/chat/components/chat-message-markdown.types.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;
type DockElementAttributes = JSX.HTMLAttributes<HTMLElement> & {
  [key: `prop:${string}`]: unknown;
};
type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];

export type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };
type ChatCiProperties = {
  gateway?: ApplicationGateway;
  pullRequest?: ControlUiSessionPullRequest;
  sessionKey: string;
  presented: boolean;
  inline?: boolean;
  // Match the native menu registry without pulling renderer modules into SDK declarations.
  controls?: {
    readonly elements: ReadonlySet<HTMLElement>;
    ref(this: void): (element: HTMLElement) => void;
  };
};
type PluginViewProperties = {
  [Surface in keyof ControlUiSurfaceProps]: {
    "prop:surface": Surface;
    "prop:props": ControlUiSurfaceProps[Surface];
  };
}[keyof ControlUiSurfaceProps];

declare module "@solidjs/web" {
  namespace JSX {
    interface EventHandlersElement<T> {
      "onOpenclaw-composer-dismiss-invocations"?: EventHandlerUnion<T, CustomEvent>;
    }
    interface ExplicitProperties {
      messageActions: MessageActionDetails | null | undefined;
    }
    interface IntrinsicElements {
      "openclaw-activity-page": HTMLAttributes<HTMLElement>;
      "openclaw-cron-scratch-editor": HTMLAttributes<HTMLElement>;
      "openclaw-ip-location": HTMLAttributes<HTMLElement>;
      "openclaw-home-session": HTMLAttributes<HTMLElement>;
      "openclaw-session-owner-chip": HTMLAttributes<HTMLElement> & {
        size?: "row" | "header";
        attribution?: "created" | "owned" | "archived";
      };
      "openclaw-elapsed-time": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-output": HTMLAttributes<HTMLElement>;
      "openclaw-chat-sent-comments": HTMLAttributes<HTMLElement>;
      "openclaw-chat-sources": HTMLAttributes<HTMLElement>;
      "openclaw-chat-summary-automations": HTMLAttributes<HTMLElement>;
      "openclaw-chat-details-progress": HTMLAttributes<HTMLElement>;
      "openclaw-microphone-activity": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-content": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-raw": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-outcome": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-card": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-icon": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-reviews": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-outcome-summary": HTMLAttributes<HTMLElement>;
      "openclaw-chat-tool-review-outcome": HTMLAttributes<HTMLElement>;
      "openclaw-custodian-setup-card": HTMLAttributes<HTMLElement>;
      "openclaw-agent-memory-panel": HTMLAttributes<HTMLElement>;
      "openclaw-chat-ci-details": HTMLAttributes<HTMLElement> &
        ElementProperties<ChatCiProperties & { menuControls?: boolean }>;
      "openclaw-chat-ci-automation": HTMLAttributes<HTMLElement> &
        ElementProperties<ChatCiProperties & { sessionId: string; menuPresentation?: boolean }>;
      "openclaw-panel-empty-state": HTMLAttributes<HTMLElement>;
      "openclaw-panel-loading-skeleton": HTMLAttributes<HTMLElement> & {
        compact?: string;
        overlay?: string;
      };
      "openclaw-terminal-panel": DockElementAttributes & { fullscreen?: boolean };
      "openclaw-browser-panel": DockElementAttributes;
      "openclaw-link-reader-panel": DockElementAttributes;
      "openclaw-appearance-background": HTMLAttributes<HTMLElement>;
      "openclaw-config-page": HTMLAttributes<HTMLElement>;
      "openclaw-sidebar-update-card": HTMLAttributes<HTMLElement>;
      "openclaw-native-chrome-setup": HTMLAttributes<HTMLElement>;
      "openclaw-theme-brand-icon": HTMLAttributes<HTMLElement>;
      "openclaw-mcp-app-resources": HTMLAttributes<HTMLElement>;
      "openclaw-mcp-app-context-strip": HTMLAttributes<HTMLElement>;
      "openclaw-mcp-app-panel": HTMLAttributes<HTMLElement>;
      "openclaw-meeting-capture-settings": HTMLAttributes<HTMLElement>;
      "openclaw-session-storage-settings": HTMLAttributes<HTMLElement>;
      "openclaw-talk-settings": HTMLAttributes<HTMLElement>;
      "openclaw-memory-settings": HTMLAttributes<HTMLElement>;
      "openclaw-memory-memories": HTMLAttributes<HTMLElement>;
      "openclaw-modal-actions": HTMLAttributes<HTMLElement>;
      "openclaw-claws-explore": HTMLAttributes<HTMLElement> & {
        "prop:onSelect"?: (
          entry: import("../pages/agents-home/claws-catalog-client.ts").ClawCatalogEntry,
        ) => void;
      };
      "openclaw-claws-catalog-dialog": HTMLAttributes<HTMLElement>;
      "openclaw-github-identity": HTMLAttributes<HTMLElement>;
      "openclaw-chat-permission-card": HTMLAttributes<HTMLElement>;
      "openclaw-chat-run-failure-notice": HTMLAttributes<HTMLElement>;
      "openclaw-chat-retry-status": HTMLAttributes<HTMLElement>;
      "openclaw-chat-child-attention": HTMLAttributes<HTMLElement>;
      "openclaw-session-diff-menu": HTMLAttributes<HTMLElement>;
      "openclaw-mcp-servers-card": HTMLAttributes<HTMLElement>;
      "openclaw-mcp-app-catalog": HTMLAttributes<HTMLElement> & { surface?: string };
      "openclaw-update-run-view": HTMLAttributes<HTMLElement>;
      "openclaw-plugins-page": HTMLAttributes<HTMLElement>;
      "openclaw-dashboards-page": HTMLAttributes<HTMLElement>;
      "openclaw-lobster-pet": HTMLAttributes<HTMLElement> & ElementProperties<LobsterPetProps>;
      // Each caller validates the picker option/callback pairing before the DOM boundary.
      "openclaw-select-picker": HTMLAttributes<HTMLElementTagNameMap["openclaw-select-picker"]> & {
        "prop:params": unknown;
      };
      "openclaw-plugin-view": HTMLAttributes<HTMLElement> &
        PluginViewProperties & {
          "prop:defaultView": unknown;
          "prop:replacementCompanion"?: unknown;
          "prop:presented": boolean;
        };
      "openclaw-message-reaction-picker": HTMLAttributes<HTMLElement> & {
        compact?: boolean;
      };
      "openclaw-chat-clawhub-card": HTMLAttributes<HTMLElement> & {
        "prop:recommendation"?: ClawHubRecommendation;
        "prop:agentId"?: string;
      };
      "resizable-divider": Omit<HTMLAttributes<HTMLElement>, "onResize"> & {
        "prop:orientation"?: "horizontal" | "vertical";
        "prop:label": string;
        "prop:splitRatio": number;
        "prop:minRatio": number;
        "prop:maxRatio": number;
        "prop:measureRatio"?: () => number;
        "prop:measureSize"?: () => number;
        onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
        "onResize-end"?: () => void;
      };
      "openclaw-tooltip": HTMLAttributes<Tooltip> & {
        "prop:content"?: Tooltip["content"];
        "prop:describe"?: Tooltip["describe"];
        "prop:descriptionTarget"?: Tooltip["descriptionTarget"];
        "prop:pointerThrough"?: Tooltip["pointerThrough"];
        "prop:openOnClick"?: Tooltip["openOnClick"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        "prop:closeDelay"?: Tooltip["closeDelay"];
        "prop:hoverDismissDelay"?: Tooltip["hoverDismissDelay"];
        "prop:delay"?: Tooltip["delay"];
        "prop:autoSize"?: Tooltip["autoSize"];
        content?: string;
        disabled?: boolean;
        placement?: Tooltip["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "openclaw-viewer-facepile": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-viewer-facepile"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-viewer-facepile"],
            | "staticParticipants"
            | "staticUsers"
            | "presencePayload"
            | "selfUser"
            | "selfInstanceId"
            | "sessionKey"
            | "excludeIdentities"
            | "totalCount"
            | "maxVisible"
            | "personActivity"
          >
        > & { variant?: "session" };
      "openclaw-viewer-avatar": HTMLAttributes<HTMLElementTagNameMap["openclaw-viewer-avatar"]> &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-viewer-avatar"],
            "identity" | "user" | "markAsViewer"
          >
        > & { variant?: HTMLElementTagNameMap["openclaw-viewer-avatar"]["variant"] };
      "openclaw-link-reader-hovercard-provider": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"],
            | "client"
            | "readers"
            | "agentId"
            | "sessionKey"
            | "previewSeeds"
            | "pagePreviewContext"
            | "claimedReaders"
          >
        >;
      "openclaw-chat-pdf-preview": HTMLAttributes<HTMLElement>;
      "openclaw-chat-pane-versions-menu": HTMLAttributes<HTMLElement>;
      "openclaw-chat-skill-learned-notice": HTMLAttributes<HTMLElement>;
      "openclaw-agent-row-chip": HTMLAttributes<HTMLElement> & {
        "prop:agentId"?: string;
      };
      "openclaw-systems-page": HTMLAttributes<HTMLElement>;
      "openclaw-systems-sidebar": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-systems-sidebar"]
      > &
        ElementProperties<Pick<HTMLElementTagNameMap["openclaw-systems-sidebar"], "controller">>;
      "openclaw-mascot": LegacyAttributes<HTMLElement> & {
        mood?: MascotMood;
        "prop:size"?: number;
      };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
