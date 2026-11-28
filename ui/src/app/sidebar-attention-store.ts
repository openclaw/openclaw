import { createChangeListeners } from "../../../src/shared/listeners.js";
import type { SidebarAttentionDismissal } from "../components/sidebar-attention-dismissals.ts";
import type { SidebarInboxEntry } from "../components/sidebar-attention-entries.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ApplicationConfigCapability } from "./config.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { MentionsCapability } from "./mentions.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

export type SidebarAttentionStoreSources = {
  gateway: ApplicationGateway;
  config: Pick<ApplicationConfigCapability, "current" | "subscribe">;
  agentSelection: AgentSelectionCapability;
  agents: AgentCapability;
  overlays: ApplicationOverlays;
  connectionBootstrap?: ConnectionBootstrapCoordinator;
};

export type SidebarAttentionStoreOwner = {
  readonly entries: readonly SidebarInboxEntry[];
  readonly hasFailedAutomation: boolean;
  readonly mentions: MentionsCapability;
  dismiss(dismissal: SidebarAttentionDismissal): void;
  syncDismissals(): void;
  refreshOpenClawId(): void;
  dispose(): void;
};

type SidebarAttentionStoreOwnerConstructor = new (
  sources: SidebarAttentionStoreSources,
  onChange: () => void,
) => SidebarAttentionStoreOwner;

export type SidebarAttentionStore = ReturnType<typeof createSidebarAttentionStore>;

export function createSidebarAttentionStore(sources: SidebarAttentionStoreSources) {
  const listeners = createChangeListeners();
  let owner: SidebarAttentionStoreOwner | null = null;
  // Reconcile account state before any lazy Inbox source can publish the new snapshot.
  const stopGateway = sources.gateway.subscribe(() => owner?.syncDismissals());
  return {
    get entries() {
      return owner?.entries ?? [];
    },
    get hasFailedAutomation() {
      return owner?.hasFailedAutomation ?? false;
    },
    activate(Owner: SidebarAttentionStoreOwnerConstructor) {
      owner ??= new Owner(sources, listeners.publish);
      return owner.mentions;
    },
    refreshOpenClawId() {
      owner?.refreshOpenClawId();
    },
    dismiss(dismissal: SidebarAttentionDismissal) {
      owner?.dismiss(dismissal);
    },
    subscribe: listeners.subscribe,
    dispose() {
      stopGateway();
      owner?.dispose();
      owner = null;
      listeners.clear();
    },
  };
}
