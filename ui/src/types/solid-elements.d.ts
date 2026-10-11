// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
    }
  }
}
