import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
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
