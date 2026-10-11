// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-panel-empty-state": HTMLAttributes<HTMLElement> & {
        "prop:heading": string;
        "prop:description": string;
      };
      "openclaw-panel-loading-skeleton": HTMLAttributes<HTMLElement> & {
        "prop:variant": import("../components/solid/panel-loading-skeleton.tsx").PanelLoadingSkeletonVariant;
        "prop:label": string;
        compact?: boolean;
        overlay?: boolean;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
    }
  }
}
