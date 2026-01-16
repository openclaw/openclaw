import type { NodeBridgeServer } from "../infra/bridge/server.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
import type { BridgeTlsRuntime } from "../infra/bridge/server/tls.js";
import type { ClawdbotConfig } from "../config/config.js";
import { bumpSkillsSnapshotVersion } from "../agents/skills/refresh.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../infra/skills-remote.js";
import { listSystemPresence, upsertPresence } from "../infra/system-presence.js";
import { loadVoiceWakeConfig } from "../infra/voicewake.js";
import { isLoopbackAddress } from "./net.js";
import {
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";
import type { BridgeEvent, BridgeRequest, BridgeResponse } from "./server-bridge-types.js";

export type GatewayNodeBridgeRuntime = {
  bridge: NodeBridgeServer | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
};

export async function startGatewayNodeBridge(params: {
  cfg: ClawdbotConfig;
  bridgeEnabled: boolean;
  bridgePort: number;
  bridgeHost: string | null;
  bridgeTls?: BridgeTlsRuntime;
  machineDisplayName: string;
  canvasHostPort?: number;
  canvasHostHost?: string;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  bridgeUnsubscribeAll: (nodeId: string) => void;
  handleBridgeRequest: (nodeId: string, req: BridgeRequest) => Promise<BridgeResponse>;
  handleBridgeEvent: (nodeId: string, evt: BridgeEvent) => Promise<void> | void;
  logBridge: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<GatewayNodeBridgeRuntime> {
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();

  const stopNodePresenceTimer = (nodeId: string) => {
    const timer = nodePresenceTimers.get(nodeId);
    if (timer) {
      clearInterval(timer);
    }
    nodePresenceTimers.delete(nodeId);
  };

  const beaconNodePresence = (
    node: {
      nodeId: string;
      displayName?: string;
      remoteIp?: string;
      version?: string;
      platform?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
    },
    reason: string,
  ) => {
    const host = node.displayName?.trim() || node.nodeId;
    const rawIp = node.remoteIp?.trim();
    const ip = rawIp && !isLoopbackAddress(rawIp) ? rawIp : undefined;
    const version = node.version?.trim() || "unknown";
    const platform = node.platform?.trim() || undefined;
    const deviceFamily = node.deviceFamily?.trim() || undefined;
    const modelIdentifier = node.modelIdentifier?.trim() || undefined;
    const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason ${reason}`;
    upsertPresence(node.nodeId, {
      host,
      ip,
      version,
      platform,
      deviceFamily,
      modelIdentifier,
      mode: "remote",
      reason,
      lastInputSeconds: 0,
      instanceId: node.nodeId,
      text,
    });
    incrementPresenceVersion();
    params.broadcast(
      "presence",
      { presence: listSystemPresence() },
      {
        dropIfSlow: true,
        stateVersion: {
          presence: getPresenceVersion(),
          health: getHealthVersion(),
        },
      },
    );
  };

  const startNodePresenceTimer = (node: { nodeId: string }) => {
    stopNodePresenceTimer(node.nodeId);
    nodePresenceTimers.set(
      node.nodeId,
      setInterval(() => {
        beaconNodePresence(node, "periodic");
      }, 180_000),
    );
  };

  if (params.bridgeEnabled && params.bridgePort > 0 && params.bridgeHost) {
    try {
      const started = await startNodeBridgeServer({
        host: params.bridgeHost,
        port: params.bridgePort,
        tls: params.bridgeTls?.tlsOptions,
        serverName: params.machineDisplayName,
        canvasHostPort: params.canvasHostPort,
        canvasHostHost: params.canvasHostHost,
        onRequest: (nodeId, req) => params.handleBridgeRequest(nodeId, req),
        onAuthenticated: async (node) => {
          beaconNodePresence(node, "node-connected");
          startNodePresenceTimer(node);
          recordRemoteNodeInfo({
            nodeId: node.nodeId,
            displayName: node.displayName,
            platform: node.platform,
            deviceFamily: node.deviceFamily,
            commands: node.commands,
          });
          bumpSkillsSnapshotVersion({ reason: "remote-node" });
          await refreshRemoteNodeBins({
            nodeId: node.nodeId,
            platform: node.platform,
            deviceFamily: node.deviceFamily,
            commands: node.commands,
            cfg: params.cfg,
          });

          try {
            const cfg = await loadVoiceWakeConfig();
            started.sendEvent({
              nodeId: node.nodeId,
              event: "voicewake.changed",
              payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
            });
          } catch {
            // Best-effort only.
          }
        },
        onDisconnected: (node) => {
          params.bridgeUnsubscribeAll(node.nodeId);
          stopNodePresenceTimer(node.nodeId);
          beaconNodePresence(node, "node-disconnected");
        },
        onEvent: params.handleBridgeEvent,
        onPairRequested: (request) => {
          params.broadcast("node.pair.requested", request, {
            dropIfSlow: true,
          });
        },
      });
      if (started.port > 0) {
        const scheme = params.bridgeTls?.enabled ? "tls" : "tcp";
        params.logBridge.info(
          `listening on ${scheme}://${params.bridgeHost}:${started.port} (node)`,
        );
        return { bridge: started, nodePresenceTimers };
      }
    } catch (err) {
      params.logBridge.warn(`failed to start: ${String(err)}`);
    }
  } else if (params.bridgeEnabled && params.bridgePort > 0 && !params.bridgeHost) {
    params.logBridge.warn(
      "bind policy requested tailnet IP, but no tailnet interface was found; refusing to start bridge",
    );
  }

  return { bridge: null, nodePresenceTimers };
}
