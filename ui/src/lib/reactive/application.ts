import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { MentionsCapability } from "../../app/mentions.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import type { SidebarAttentionStore } from "../../app/sidebar-attention-store.ts";
import { projectSource } from "./projection.ts";

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
