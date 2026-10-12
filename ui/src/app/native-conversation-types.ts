import type { RouteLocation } from "@openclaw/uirouter";
import type { StoredSidebarSessionFacts } from "../lib/chat/outbox-store-projection.ts";

export type NativeConversationBridge = {
  readonly presentation: { visible: boolean; active: boolean };
  readonly supportsSessionActions: boolean;
  subscribe(listener: () => void): () => void;
  interceptNavigation(location: RouteLocation): boolean;
  publishSessionFacts(sessions: readonly StoredSidebarSessionFacts[] | null): void;
  dispose(): void;
};
