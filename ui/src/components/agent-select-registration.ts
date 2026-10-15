import type { AgentSelectElement, AgentSelectOption } from "./agent-select.ts";
import "./agent-select.tsx";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-select": AgentSelectElement;
  }
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-select": HTMLAttributes<AgentSelectElement> & {
        name?: string;
        "prop:options": readonly AgentSelectOption[];
        "prop:variant"?: AgentSelectElement["variant"];
        "prop:identityById"?: AgentSelectElement["identityById"];
        "prop:menuLabel"?: string;
        "prop:value": string;
        "prop:accessibleLabel": string;
        "prop:disabled": boolean;
        "prop:onSelect": (value: string) => void;
      };
    }
  }
}
