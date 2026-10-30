import { handleChatLiveEvent as handleLiveEvent } from "./chat-live-events.runtime.ts";
import { isChatLiveEvent } from "./chat-live-events.ts";
import { handlePageGatewayEvent as handleStateEvent } from "./chat-state-events.ts";

/** Exercise synchronous reducers directly; lazy admission has its own held-import proof. */
export function handlePageGatewayEvent(...args: Parameters<typeof handleStateEvent>): void {
  if (isChatLiveEvent(args[1])) {
    handleLiveEvent(args[0], args[1], args[2]);
  } else {
    handleStateEvent(...args);
  }
}
