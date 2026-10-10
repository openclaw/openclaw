import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { AssistantDock } from "../../app/assistant-dock.ts";
import type { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import type { ApplicationChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationNavigationPreferences } from "../../app/context.ts";
import type { ScopeUpgradeCapability } from "../../app/device-scope-upgrade.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { MentionsCapability } from "../../app/mentions.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import type { ApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import type { SidebarAttentionStore } from "../../app/sidebar-attention-store.ts";
import type { WebPushCapability } from "../../app/web-push.ts";
import type { SessionCapability } from "../sessions/index.ts";
import { projectEvents, projectSource } from "./projection.ts";

/** Connection identity and its snapshot publish through the same owner subscription. */
export function projectGateway(source: ApplicationGateway) {
  return projectSource(source, {
    read: (gateway) => ({
      snapshot: gateway.snapshot,
      connection: gateway.connection,
      connectionRevision: gateway.connectionRevision,
    }),
    subscribe: (gateway, notify) => gateway.subscribe(notify),
    equality: "revision",
  });
}

/** Acquiring this projection enables diagnostic capture; the last reader releases it. */
export function projectGatewayEventLog(source: ApplicationGateway) {
  return projectSource(source, {
    read: (gateway) => ({ entries: gateway.eventLog, revision: gateway.eventLogRevision }),
    subscribe: (gateway, notify) => gateway.subscribeEventLog(notify),
    equality: "revision",
  });
}

export function projectGatewayEvents(source: ApplicationGateway) {
  return projectEvents<
    ApplicationGateway,
    Parameters<Parameters<ApplicationGateway["subscribeEvents"]>[0]>[0]
  >(source, { subscribe: (gateway, listener) => gateway.subscribeEvents(listener) });
}

export function projectApplicationConfig(source: ApplicationConfigCapability) {
  return projectSource(source, {
    read: (config) => config.current,
    subscribe: (config, notify) => config.subscribe(notify),
    equality: "revision",
  });
}

export function projectAgentSelection(source: AgentSelectionCapability) {
  return projectSource(source, {
    read: (selection) => ({ state: selection.state, intentRevision: selection.intentRevision }),
    subscribe: (selection, notify) => selection.subscribe(notify),
    equality: "revision",
  });
}

export function projectNavigationPreferences(source: ApplicationNavigationPreferences) {
  return projectSource(source, {
    read: (navigation) => navigation.snapshot,
    subscribe: (navigation, notify) => navigation.subscribe(notify),
    equality: "revision",
  });
}

export function projectAssistantDock(source: AssistantDock) {
  return projectSource(source, {
    read: (dock) => dock.openSessionKey,
    subscribe: (dock, notify) => dock.subscribe(notify),
    equality: Object.is,
  });
}

export function projectChatInputOwner(source: ReturnType<typeof chatInputOwnerForContext>) {
  return projectSource(source, {
    read: (owner) => owner.current,
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: Object.is,
  });
}

/** Private display bytes stay behind readCreateMessage's live authority check. */
export function projectChatCreation(source: ApplicationChatSubmissions) {
  return projectSource(source, {
    read: (submissions) => submissions.creation,
    subscribe: (submissions, notify) => submissions.subscribeCreate(notify),
    equality: "revision",
  });
}

export function projectOverlays(source: ApplicationOverlays) {
  return projectSource(source, {
    read: (overlays) => overlays.snapshot,
    subscribe: (overlays, notify) => overlays.subscribe(notify),
    equality: "revision",
  });
}

export function projectMentions(source: MentionsCapability) {
  return projectSource(source, {
    read: (mentions) => mentions.snapshot,
    subscribe: (mentions, notify) => mentions.subscribe(notify),
    equality: "revision",
  });
}

export function projectSidebarAttention(source: SidebarAttentionStore) {
  return projectSource(source, {
    read: (attention) => attention.entries,
    subscribe: (attention, notify) => attention.subscribe(notify),
    equality: "revision",
  });
}

export function projectScopeUpgrade(source: ScopeUpgradeCapability) {
  return projectSource(source, {
    read: (upgrade) => upgrade.state,
    subscribe: (upgrade, notify) => upgrade.subscribe(notify),
    equality: "revision",
  });
}

export function projectWebPush(source: WebPushCapability) {
  return projectSource(source, {
    read: (push) => push.snapshot,
    subscribe: (push, notify) => push.subscribe(notify),
    equality: "revision",
  });
}

export type PlacementStartupProjectionSource = {
  startup: ApplicationPlacementStartup;
  sessions: Pick<SessionCapability, "subscribe">;
  sessionKey: string;
};

/** The facade owns lazy startup; observing never imports or starts its runtime. */
export function projectPlacementStartup(source: PlacementStartupProjectionSource) {
  return projectSource(source, {
    read: ({ startup, sessionKey }) => ({
      status: startup.get(sessionKey),
      hasPendingTurn: startup.hasPendingTurn(sessionKey),
    }),
    subscribe: ({ startup, sessions }, notify) => {
      const stopStartup = startup.subscribe(notify);
      const stopSessions = sessions.subscribe(notify);
      return () => {
        stopSessions();
        stopStartup();
      };
    },
    equality: "revision",
  });
}
