// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";
import "../components/tooltip.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        "open-on-click"?: boolean;
      };
    }
  }
}
