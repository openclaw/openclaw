import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";

export type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<WaTabGroup> & {
        "prop:active"?: string;
        activation?: "auto" | "manual";
        "without-scroll-controls"?: boolean;
        "onWa-tab-show"?: (event: CustomEvent<{ name: string }>) => void;
      };
      "wa-tab": HTMLAttributes<HTMLElement> & {
        panel?: string;
        active?: boolean;
        "prop:active"?: boolean;
        "prop:tabIndex"?: number;
      };
      "wa-tab-panel": HTMLAttributes<HTMLElement> &
        Properties<HTMLElement> & {
          name?: string;
          active?: boolean;
          "prop:active"?: boolean;
        };
      "resizable-divider": Omit<HTMLAttributes<HTMLElement>, "onResize"> & {
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
