// Keep protocol imports narrow: NodeSession is reachable through the public SDK.
import type { DesktopAvailability } from "../../packages/gateway-protocol/src/schema/environments.js";
import type {
  NodePluginToolDescriptor,
  NodeSkillDescriptor,
} from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { GatewayWsClient } from "./server/ws-types.js";

/** Connected node session advertised over Gateway websocket. */
export type NodeSession = {
  nodeId: string;
  connId: string;
  /** Persistent device key and node-token identity authenticated for this connection. */
  pairingIdentity?: string;
  /** Persistent pairing generation authenticated before this session was registered. */
  pairingGeneration?: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  declaredCaps: string[];
  sessionCapsCeiling?: string[];
  caps: string[];
  declaredCommands: string[];
  sessionCommandsCeiling?: string[];
  commands: string[];
  declaredComputerUse?: ComputerUseCapabilityDescriptor;
  computerUse?: ComputerUseCapabilityDescriptor;
  declaredNodePluginTools: NodePluginToolDescriptor[];
  nodePluginTools: NodePluginToolDescriptor[];
  nodeSkills: NodeSkillDescriptor[];
  declaredPermissions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
  lastActiveAtMs?: number;
  presenceUpdatedAtMs?: number;
  hostStats?: NodeHostStats;
  desktopAvailability?: DesktopAvailability;
};
