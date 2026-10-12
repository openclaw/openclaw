import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { projectOwner, projectSource } from "./projection.ts";

/** Connection identity and its snapshot publish through the same owner subscription. */
export function projectGateway(source: ApplicationGateway) {
  return projectOwner(source, (gateway) => ({
    snapshot: gateway.snapshot,
    connection: gateway.connection,
    connectionRevision: gateway.connectionRevision,
  }));
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
  return projectOwner(source, (config) => config.current);
}

export function projectAgentSelection(source: AgentSelectionCapability) {
  return projectOwner(source, (selection) => ({
    state: selection.state,
    intentRevision: selection.intentRevision,
  }));
}
