import type { JSX } from "@solidjs/web";
import type { BrowserPanelInputs } from "./browser/browser-panel-registration.tsx";
import type { DesktopPanelInputs } from "./desktop/desktop-panel-registration.tsx";
import type { PanelLoadingSkeletonVariant } from "./panel-loading-skeleton.ts";
import type { TerminalInputs } from "./terminal/terminal-panel-registration.tsx";

type ElementAttributes = JSX.HTMLAttributes<HTMLElement>;
type PanelAttributes<Props> = ElementAttributes & {
  [Key in keyof Props as `prop:${Key & string}`]?: Props[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-terminal-panel": PanelAttributes<TerminalInputs> & {
        embedded?: boolean;
        fullscreen?: boolean;
      };
      "openclaw-browser-panel": PanelAttributes<BrowserPanelInputs> & { embedded?: boolean };
      "openclaw-desktop-panel": PanelAttributes<DesktopPanelInputs> & { embedded?: boolean };
      "openclaw-tooltip": ElementAttributes & {
        "prop:content": string;
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
      "resizable-divider": Omit<ElementAttributes, "onResize"> & {
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
