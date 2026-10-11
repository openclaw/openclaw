import type { JSX } from "@solidjs/web";

type ElementAttributes = JSX.HTMLAttributes<HTMLElement>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
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
