export type NodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  command?: string;
  params?: string;
  invokeTimeout?: string;
  idempotencyKey?: string;
  connected?: boolean;
  lastConnected?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
  cwd?: string;
  env?: string[];
  commandTimeout?: string;
  needsScreenRecording?: boolean;
  title?: string;
  body?: string;
  sound?: string;
  priority?: string;
  delivery?: string;
  name?: string;
  facing?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
  delayMs?: string;
  deviceId?: string;
  maxAge?: string;
  accuracy?: string;
  locationTimeout?: string;
  duration?: string;
  screen?: string;
  fps?: string;
  audio?: boolean;
};

export type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  pathEnv?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
  connectedAtMs?: number;
};

export type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts: number;
};

export type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
};

export type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};
