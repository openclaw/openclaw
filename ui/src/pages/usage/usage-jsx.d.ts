import type { JSX } from "@solidjs/web";
import "../../components/agent-row-chip.ts";
import "../../components/session-owner-chip.ts";

type LegacyElement<
  Element extends HTMLElement,
  Property extends keyof Element,
> = JSX.HTMLAttributes<Element> & {
  [Key in Property as `prop:${Key & string}`]?: Element[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-row-chip": LegacyElement<
        HTMLElementTagNameMap["openclaw-agent-row-chip"],
        "agentId"
      >;
      "openclaw-session-owner-chip": LegacyElement<
        HTMLElementTagNameMap["openclaw-session-owner-chip"],
        "owner"
      > & { size?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["size"] };
    }
  }
}
