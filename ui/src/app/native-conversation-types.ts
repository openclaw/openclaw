import type { RouteLocation } from "@openclaw/uirouter";

export type NativeConversationBridge = {
  readonly presentation: { visible: boolean; active: boolean };
  subscribe(listener: () => void): () => void;
  interceptNavigation(location: RouteLocation): boolean;
  dispose(): void;
};
