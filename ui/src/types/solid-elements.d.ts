// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-modal-dialog": HTMLAttributes<HTMLElement> & {
        label: string;
        description?: string;
        "onModal-cancel"?: (event: Event) => void;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
    }
  }
}
