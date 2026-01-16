import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { startCanvasHost } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "../commands/health.js";
import type { ClawdbotConfig } from "../config/config.js";
import { deriveDefaultBridgePort, deriveDefaultCanvasHostPort } from "../config/port-defaults.js";
import type { NodeBridgeServer } from "../infra/bridge/server.js";
import { loadBridgeTlsRuntime } from "../infra/bridge/server/tls.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createBridgeHandlers } from "./server-bridge.js";
import {
  type BridgeListConnectedFn,
  type BridgeSendEventFn,
  createBridgeSubscriptionManager,
} from "./server-bridge-subscriptions.js";
import type { ChatRunEntry } from "./server-chat.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { startGatewayNodeBridge } from "./server-node-bridge.js";
import type { DedupeEntry } from "./server-shared.js";

export type GatewayBridgeRuntime = {
  bridge: import("../infra/bridge/server.js").NodeBridgeServer | null;
  bridgeHost: string | null;
  bridgePort: number;
  canvasHostServer: CanvasHostServer | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  bonjourStop: (() => Promise<void>) | null;
  bridgeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  bridgeSendToAllSubscribed: (event: string, payload: unknown) => void;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
};

export async function startGatewayBridgeRuntime(params: {
  cfg: ClawdbotConfig;
  port: number;
  canvasHostEnabled: boolean;
  canvasHost: CanvasHostHandler | null;
  canvasRuntime: RuntimeEnv;
  allowCanvasHostInTests?: boolean;
  machineDisplayName: string;
  deps: CliDeps;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  dedupe: Map<string, DedupeEntry>;
  agentRunSeq: Map<string, number>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getHealthCache: () => HealthSummary | null;
  refreshGatewayHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  logBridge: { info: (msg: string) => void; warn: (msg: string) => void };
  logCanvas: { warn: (msg: string) => void };
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<GatewayBridgeRuntime> {
  const wideAreaDiscoveryEnabled = params.cfg.discovery?.wideArea?.enabled === true;

  let bridgeEnabled = (() => {
    if (params.cfg.bridge?.enabled !== undefined) return params.cfg.bridge.enabled === true;
    return process.env.CLAWDBOT_BRIDGE_ENABLED !== "0";
  })();

  const bridgePort = (() => {
    if (typeof params.cfg.bridge?.port === "number" && params.cfg.bridge.port > 0) {
      return params.cfg.bridge.port;
    }
    if (process.env.CLAWDBOT_BRIDGE_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDBOT_BRIDGE_PORT, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : deriveDefaultBridgePort(params.port);
    }
    return deriveDefaultBridgePort(params.port);
  })();

  const bridgeHost = (() => {
    // Back-compat: allow an env var override when no bind policy is configured.
    if (params.cfg.bridge?.bind === undefined) {
      const env = process.env.CLAWDBOT_BRIDGE_HOST?.trim();
      if (env) return env;
    }

    const bind = params.cfg.bridge?.bind ?? (wideAreaDiscoveryEnabled ? "auto" : "lan");
    if (bind === "loopback") return "127.0.0.1";
    if (bind === "lan") return "0.0.0.0";

    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    const tailnetIPv6 = pickPrimaryTailnetIPv6();
    if (bind === "auto") {
      return tailnetIPv4 ?? tailnetIPv6 ?? "0.0.0.0";
    }
    if (bind === "custom") {
      // For bridge, customBindHost is not currently supported on GatewayConfig.
      // This will fall back to "0.0.0.0" until we add customBindHost to BridgeConfig.
      return "0.0.0.0";
    }
    return "0.0.0.0";
  })();

  const bridgeTls = bridgeEnabled
    ? await loadBridgeTlsRuntime(params.cfg.bridge?.tls, params.logBridge)
    : { enabled: false, required: false };
  if (bridgeTls.required && !bridgeTls.enabled) {
    params.logBridge.warn(bridgeTls.error ?? "bridge tls: failed to enable; bridge disabled");
    bridgeEnabled = false;
  }

  const canvasHostPort = (() => {
    if (process.env.CLAWDBOT_CANVAS_HOST_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDBOT_CANVAS_HOST_PORT, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return deriveDefaultCanvasHostPort(params.port);
    }
    const configured = params.cfg.canvasHost?.port;
    if (typeof configured === "number" && configured > 0) return configured;
    return deriveDefaultCanvasHostPort(params.port);
  })();

  let canvasHostServer: CanvasHostServer | null = null;
  if (params.canvasHostEnabled && bridgeEnabled && bridgeHost) {
    try {
      const started = await startCanvasHost({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        port: canvasHostPort,
        listenHost: bridgeHost,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
        handler: params.canvasHost ?? undefined,
        ownsHandler: params.canvasHost ? false : undefined,
      });
      if (started.port > 0) {
        canvasHostServer = started;
      }
    } catch (err) {
      params.logCanvas.warn(`failed to start on ${bridgeHost}:${canvasHostPort}: ${String(err)}`);
    }
  }

  let bridge: NodeBridgeServer | null = null;
  const bridgeSubscriptions = createBridgeSubscriptionManager();
  const bridgeSubscribe = bridgeSubscriptions.subscribe;
  const bridgeUnsubscribe = bridgeSubscriptions.unsubscribe;
  const bridgeUnsubscribeAll = bridgeSubscriptions.unsubscribeAll;
  const bridgeSendEvent: BridgeSendEventFn = (opts) => {
    bridge?.sendEvent(opts);
  };
  const bridgeListConnected: BridgeListConnectedFn = () => bridge?.listConnected() ?? [];
  const bridgeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    bridgeSubscriptions.sendToSession(sessionKey, event, payload, bridgeSendEvent);
  const bridgeSendToAllSubscribed = (event: string, payload: unknown) =>
    bridgeSubscriptions.sendToAllSubscribed(event, payload, bridgeSendEvent);
  const bridgeSendToAllConnected = (event: string, payload: unknown) =>
    bridgeSubscriptions.sendToAllConnected(event, payload, bridgeListConnected, bridgeSendEvent);

  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    const payload = { triggers };
    params.broadcast("voicewake.changed", payload, { dropIfSlow: true });
    bridgeSendToAllConnected("voicewake.changed", payload);
  };

  const { handleBridgeRequest, handleBridgeEvent } = createBridgeHandlers({
    deps: params.deps,
    broadcast: params.broadcast,
    bridgeSendToSession,
    bridgeSubscribe,
    bridgeUnsubscribe,
    broadcastVoiceWakeChanged,
    addChatRun: params.addChatRun,
    removeChatRun: params.removeChatRun,
    chatAbortControllers: params.chatAbortControllers,
    chatAbortedRuns: params.chatRunState.abortedRuns,
    chatRunBuffers: params.chatRunBuffers,
    chatDeltaSentAt: params.chatDeltaSentAt,
    dedupe: params.dedupe,
    agentRunSeq: params.agentRunSeq,
    getHealthCache: params.getHealthCache,
    refreshHealthSnapshot: params.refreshGatewayHealthSnapshot,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog ?? loadGatewayModelCatalog,
    logBridge: params.logBridge,
  });

  const canvasHostPortForBridge = canvasHostServer?.port;
  const canvasHostHostForBridge =
    canvasHostServer && bridgeHost && bridgeHost !== "0.0.0.0" && bridgeHost !== "::"
      ? bridgeHost
      : undefined;

  const bridgeRuntime = await startGatewayNodeBridge({
    cfg: params.cfg,
    bridgeEnabled,
    bridgePort,
    bridgeHost,
    bridgeTls: bridgeTls.enabled ? bridgeTls : undefined,
    machineDisplayName: params.machineDisplayName,
    canvasHostPort: canvasHostPortForBridge,
    canvasHostHost: canvasHostHostForBridge,
    broadcast: params.broadcast,
    bridgeUnsubscribeAll,
    handleBridgeRequest,
    handleBridgeEvent,
    logBridge: params.logBridge,
  });
  bridge = bridgeRuntime.bridge;

  const discovery = await startGatewayDiscovery({
    machineDisplayName: params.machineDisplayName,
    port: params.port,
    bridgePort: bridge?.port,
    bridgeTls: bridgeTls.enabled
      ? { enabled: true, fingerprintSha256: bridgeTls.fingerprintSha256 }
      : undefined,
    canvasPort: canvasHostPortForBridge,
    wideAreaDiscoveryEnabled,
    logDiscovery: params.logDiscovery,
  });

  return {
    bridge,
    bridgeHost,
    bridgePort,
    canvasHostServer,
    nodePresenceTimers: bridgeRuntime.nodePresenceTimers,
    bonjourStop: discovery.bonjourStop,
    bridgeSendToSession,
    bridgeSendToAllSubscribed,
    broadcastVoiceWakeChanged,
  };
}
