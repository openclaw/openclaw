import type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-about-page": JSX.HTMLAttributes<HTMLElement>;
      "openclaw-debug-page": JSX.HTMLAttributes<HTMLElement>;
      "openclaw-agent-row-chip": JSX.HTMLAttributes<HTMLElement> & {
        "prop:agentId"?: string;
      };
      "openclaw-elapsed-time": JSX.HTMLAttributes<HTMLElement> & {
        "prop:startMs"?: number;
        "prop:minimumUnit"?: "minute" | "second";
        "prop:singleUnit"?: boolean;
      };
    }
  }
}
