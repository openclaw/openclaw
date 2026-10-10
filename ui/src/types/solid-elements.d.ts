import type { JSX as SolidJSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": SolidJSX.HTMLAttributes<HTMLElement> & { "prop:content": string };
    }
  }
}
