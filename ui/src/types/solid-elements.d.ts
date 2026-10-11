import "@solidjs/web";
import "../components/assistant-panel-content.ts";
import "../components/home-session.runtime.ts";
import "../components/modal-dialog.ts";
import "../components/resizable-divider.ts";
import "../components/tooltip.ts";
import "../lib/toast.ts";
import "../pages/custodian/custodian-surface.ts";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { MascotMood } from "../components/mascot-pose.ts";

declare module "@solidjs/web" {
  namespace JSX {
    type OpenClawElementAttributes<Tag extends keyof HTMLElementTagNameMap> = HTMLAttributes<
      HTMLElementTagNameMap[Tag]
    > &
      Properties<HTMLElementTagNameMap[Tag]>;

    interface IntrinsicElements {
      "openclaw-tooltip": OpenClawElementAttributes<"openclaw-tooltip">;
      "openclaw-modal-dialog": OpenClawElementAttributes<"openclaw-modal-dialog"> &
        Partial<
          Pick<
            HTMLElementTagNameMap["openclaw-modal-dialog"],
            "label" | "description" | "open" | "manual"
          >
        > & {
          "onModal-cancel"?: EventHandlerUnion<
            HTMLElementTagNameMap["openclaw-modal-dialog"],
            CustomEvent<null>
          >;
        };
      "resizable-divider": Omit<OpenClawElementAttributes<"resizable-divider">, "onResize"> & {
        "prop:measureRatio"?: HTMLElementTagNameMap["resizable-divider"]["measureRatio"];
        "prop:measureSize"?: HTMLElementTagNameMap["resizable-divider"]["measureSize"];
        onResize?: EventHandlerUnion<
          HTMLElementTagNameMap["resizable-divider"],
          CustomEvent<{ splitRatio: number }>
        >;
        "onResize-end"?: EventHandlerUnion<
          HTMLElementTagNameMap["resizable-divider"],
          CustomEvent<{ splitRatio: number }>
        >;
        "onResize-start"?: EventHandlerUnion<
          HTMLElementTagNameMap["resizable-divider"],
          CustomEvent<null>
        >;
      };
      "openclaw-mascot": HTMLAttributes<HTMLElement> &
        Properties<{ mood: MascotMood; size: number; tease: boolean }>;
      "openclaw-assistant-panel-content": OpenClawElementAttributes<"openclaw-assistant-panel-content"> & {
        "prop:sessionContext"?: HTMLElementTagNameMap["openclaw-assistant-panel-content"]["sessionContext"];
        "prop:context"?: HTMLElementTagNameMap["openclaw-assistant-panel-content"]["context"];
        "prop:store"?: HTMLElementTagNameMap["openclaw-assistant-panel-content"]["store"];
        "onAssistant-custodian-store"?: EventHandlerUnion<
          HTMLElementTagNameMap["openclaw-assistant-panel-content"],
          CustomEvent<
            NonNullable<HTMLElementTagNameMap["openclaw-assistant-panel-content"]["store"]>
          >
        >;
      };
      "openclaw-home-session": OpenClawElementAttributes<"openclaw-home-session"> & {
        "prop:workContext"?: HTMLElementTagNameMap["openclaw-home-session"]["workContext"];
      };
      "openclaw-custodian-surface": OpenClawElementAttributes<"openclaw-custodian-surface"> & {
        "prop:store"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["store"];
        "prop:historyContent"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["historyContent"];
        "prop:onRetryChannelOnboarding"?: HTMLElementTagNameMap["openclaw-custodian-surface"]["onRetryChannelOnboarding"];
      };
      "openclaw-approval-countdown": HTMLAttributes<HTMLElement> &
        Properties<{ expiresAtMs: number; compact: boolean }>;
      "openclaw-toast-host": OpenClawElementAttributes<"openclaw-toast-host">;
      "openclaw-theme-brand-icon": HTMLAttributes<HTMLElement> & {
        "prop:branding"?: ThemeBranding;
      };
    }
  }
}
