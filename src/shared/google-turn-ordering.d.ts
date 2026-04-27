import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
export declare function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[];
