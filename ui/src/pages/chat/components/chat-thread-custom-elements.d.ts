import "@solidjs/web";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-comment-pins": HTMLAttributes<HTMLElement> & {
        "prop:attachments"?: readonly ChatAttachment[];
        "prop:sessionKey"?: string;
        "prop:disabled"?: boolean;
      };
    }
  }
}
