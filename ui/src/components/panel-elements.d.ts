import type { JSX } from "@solidjs/web";
import type { PanelLoadingSkeletonVariant } from "./panel-loading-skeleton.ts";

type ElementAttributes = JSX.HTMLAttributes<HTMLElement>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": ElementAttributes & {
        "prop:content"?: string | null;
        "open-on-click"?: boolean;
      };
      "openclaw-panel-empty-state": ElementAttributes & {
        "prop:heading"?: string;
        "prop:description"?: string;
      };
      "openclaw-panel-loading-skeleton": ElementAttributes & {
        "prop:variant"?: PanelLoadingSkeletonVariant;
        "prop:compact"?: boolean;
        "prop:overlay"?: boolean;
        "prop:label"?: string;
      };
      "wa-tab-group": ElementAttributes & {
        "prop:active"?: string;
        activation?: "auto" | "manual";
        "without-scroll-controls"?: boolean;
        "onWa-tab-show"?: (event: CustomEvent<{ name: string }>) => void;
      };
      "wa-tab": ElementAttributes & {
        panel?: string;
        active?: boolean;
      };
      "wa-tab-panel": ElementAttributes & {
        name?: string;
        active?: boolean;
      };
      "resizable-divider": ElementAttributes & {
        "prop:orientation": "horizontal" | "vertical";
        "prop:label": string;
        "prop:splitRatio": number;
        "prop:minRatio": number;
        "prop:maxRatio": number;
        "prop:measureRatio": () => number;
        "prop:measureSize": () => number;
        onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
        "onResize-end": () => void;
      };
    }
  }
}
