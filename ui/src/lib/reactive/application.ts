import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import type { WebPushCapability } from "../../app/web-push.ts";
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

export function projectWebPush(source: WebPushCapability) {
  return projectSource(source, {
    read: (push) => push.snapshot,
    subscribe: (push, notify) => push.subscribe(notify),
    equality: "revision",
  });
}
