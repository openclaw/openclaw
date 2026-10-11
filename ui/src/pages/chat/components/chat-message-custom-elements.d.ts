import "@solidjs/web";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import type { MessageActionDetails } from "./chat-message-markdown.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface ExplicitProperties {
      messageActions: MessageActionDetails | null | undefined;
    }
    interface IntrinsicElements {
      "openclaw-message-reaction-picker": HTMLAttributes<HTMLElement> & {
        compact?: boolean;
        placement?: "bottom-start" | "bottom-end";
        "prop:activeEmoji"?: ReadonlySet<string>;
        "prop:onSelect"?: (emoji: string, remove: boolean) => void;
      };
      "openclaw-chat-clawhub-card": HTMLAttributes<HTMLElement> & {
        "prop:recommendation"?: ClawHubRecommendation;
        "prop:agentId"?: string;
      };
    }
  }
}
