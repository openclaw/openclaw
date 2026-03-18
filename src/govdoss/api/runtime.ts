import { createDefaultDeps } from "../../cli/deps.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";

export function createGovdossGatewayContext(): GatewayRequestContext {
  const deps = createDefaultDeps();
  const logGateway = createSubsystemLogger("govdoss-gateway");

  return {
    deps,
    cron: deps.cron,
    cronStorePath: "./.govdoss-cron.json",
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({ ok: true } as any),
    logHealth: { error: (message: string) => logGateway.error(message) },
    logGateway,
    incrementPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedMobileNode: () => false,
    nodeRegistry: deps.nodeRegistry,
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    addChatRun: () => {},
    removeChatRun: () => undefined,
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () => ({}) as any,
    startChannel: async () => {},
    stopChannel: async () => {},
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {},
    broadcastVoiceWakeChanged: () => {},
  };
}
