import type { AgentSelectOption } from "./agent-select.ts";
import { AgentSelect } from "./agent-select.ts";

if (!customElements.get("openclaw-agent-select")) {
  customElements.define("openclaw-agent-select", AgentSelect);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-select": AgentSelect;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-select": HTMLAttributes<AgentSelect> & {
        name?: string;
        "prop:options": readonly AgentSelectOption[];
        "prop:value": string;
        "prop:accessibleLabel": string;
        "prop:disabled": boolean;
        "prop:onSelect": (value: string) => void;
      };
    }
  }
}
