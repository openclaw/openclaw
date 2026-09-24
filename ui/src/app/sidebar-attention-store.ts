import {
  clearSidebarAttentionDismissal,
  resolveSidebarAttentionKey,
  resolveScopeUpgradeDismissal,
  type SidebarAttentionDismissal,
} from "../components/sidebar-attention-dismissals.ts";
import type { SidebarInboxEntry } from "../components/sidebar-attention-entries.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { createMentionsCapability, MentionsCapability } from "./mentions.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

export type SidebarAttentionStoreSources = {
  gateway: ApplicationGateway;
  agentSelection: AgentSelectionCapability;
  agents: AgentCapability;
  overlays: ApplicationOverlays;
  scopeUpgrade: ScopeUpgradeCapability;
  connectionBootstrap?: ConnectionBootstrapCoordinator;
};

export type SidebarAttentionStoreControllerSources = SidebarAttentionStoreSources & {
  mentions: MentionsCapability;
};

export type SidebarAttentionStoreController = {
  readonly entries: readonly SidebarInboxEntry[];
  dismiss(dismissal: SidebarAttentionDismissal): void;
  syncDismissals(): void;
  dispose(): void;
};

type SidebarAttentionStoreControllerConstructor = new (
  sources: SidebarAttentionStoreControllerSources,
  onChange: () => void,
) => SidebarAttentionStoreController;

export type SidebarAttentionStore = {
  getMentions(create: typeof createMentionsCapability): MentionsCapability;
  readonly entries: readonly SidebarInboxEntry[];
  activate(
    Controller: SidebarAttentionStoreControllerConstructor,
    create: typeof createMentionsCapability,
  ): MentionsCapability;
  dismiss(dismissal: SidebarAttentionDismissal): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export function createSidebarAttentionStore(
  sources: SidebarAttentionStoreSources,
): SidebarAttentionStore {
  // Lazy consumers supply code; this facade alone owns the shared instance.
  let mentions: MentionsCapability | undefined;
  const getMentions = (create: typeof createMentionsCapability) =>
    (mentions ??= create(sources.gateway, { connectionBootstrap: sources.connectionBootstrap }));
  const listeners = new Set<() => void>();
  let controller: SidebarAttentionStoreController | null = null;
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  // Settings intentionally mounts no Inbox, so dismissal retirement belongs to this eager facade.
  const synchronizeScopeUpgradeDismissal = () => {
    const snapshot = sources.gateway.snapshot;
    const scopes = snapshot.hello?.auth?.scopes;
    if (
      snapshot.phase === "connected" &&
      scopes &&
      !resolveScopeUpgradeDismissal({ scopes, state: sources.scopeUpgrade.state })
    ) {
      clearSidebarAttentionDismissal(resolveSidebarAttentionKey(sources.gateway), "scopeUpgrade");
    }
    controller?.syncDismissals();
  };
  const stopGateway = sources.gateway.subscribe(synchronizeScopeUpgradeDismissal);
  const stopScopeUpgrade = sources.scopeUpgrade.subscribe(synchronizeScopeUpgradeDismissal);
  synchronizeScopeUpgradeDismissal();
  return {
    getMentions,
    get entries() {
      return controller?.entries ?? [];
    },
    activate(Controller, create) {
      const ownedMentions = getMentions(create);
      controller ??= new Controller({ ...sources, mentions: ownedMentions }, publish);
      return ownedMentions;
    },
    dismiss(dismissal) {
      controller?.dismiss(dismissal);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopGateway();
      stopScopeUpgrade();
      controller?.dispose();
      controller = null;
      mentions?.dispose();
      listeners.clear();
    },
  };
}
