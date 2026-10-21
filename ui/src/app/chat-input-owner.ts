import { createChangeListeners } from "../../../src/shared/listeners.js";

export type ChatInputRegion = "page" | "dock";

class ChatInputOwner {
  private region: ChatInputRegion = "page";
  private readonly listeners = createChangeListeners();

  get current(): ChatInputRegion {
    return this.region;
  }

  claim(region: ChatInputRegion): void {
    if (this.region === region) {
      return;
    }
    this.region = region;
    this.listeners.publish();
  }

  readonly subscribe = this.listeners.subscribe;
}

// Focus belongs to one application, not a document-global singleton or a route.
const chatInputOwners = new WeakMap<object, ChatInputOwner>();

export function chatInputOwnerForContext(context: object): ChatInputOwner {
  let owner = chatInputOwners.get(context);
  if (!owner) {
    owner = new ChatInputOwner();
    chatInputOwners.set(context, owner);
  }
  return owner;
}
