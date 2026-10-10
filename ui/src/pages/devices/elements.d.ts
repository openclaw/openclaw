import type { JSX } from "@solidjs/web";
import type { AgentSelectOption } from "../../components/agent-select.ts";

// The remaining Lit controls own their host DOM until their renderer lane lands.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-dropdown": JSX.HTMLAttributes<HTMLElementTagNameMap["wa-dropdown"]> & {
        placement?: string;
        "onWa-select"?: (event: CustomEvent<{ item: { value?: string } }>) => void;
      };
      "wa-dropdown-item": JSX.HTMLAttributes<HTMLElementTagNameMap["wa-dropdown-item"]> & {
        value?: string;
        disabled?: boolean;
        variant?: string;
      };
      "openclaw-agent-select": JSX.HTMLAttributes<
        HTMLElementTagNameMap["openclaw-agent-select"]
      > & {
        "prop:options": AgentSelectOption[];
        "prop:value": string;
        "prop:accessibleLabel": string;
        "prop:disabled": boolean;
        "prop:onSelect": (value: string) => void;
      };
    }
  }
}
