// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";
import "../components/tooltip.ts";

type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<Tooltip> & {
        "prop:content"?: Tooltip["content"];
        "prop:contentTemplate"?: Tooltip["contentTemplate"];
        "prop:describe"?: Tooltip["describe"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        content?: string;
        disabled?: boolean;
        "open-on-click"?: boolean;
      };
    }
  }
}
