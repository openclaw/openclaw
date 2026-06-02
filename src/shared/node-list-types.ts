export type NodeListNode = {
  /** Stable node id used for RPC routing and pairing lookup. */
  nodeId: string;
  /** User-facing node label, when the node or operator supplied one. */
  displayName?: string;
  /** Runtime platform reported by the node process. */
  platform?: string;
  /** Node application version reported by older clients. */
  version?: string;
  /** Core package version reported by the node. */
  coreVersion?: string;
  /** UI package version reported by the node, when applicable. */
  uiVersion?: string;
  /** Client/session id for the active node connection. */
  clientId?: string;
  /** Connection mode such as desktop, mobile, or remote runtime. */
  clientMode?: string;
  /** Last observed remote address for diagnostics and pairing review. */
  remoteIp?: string;
  /** Device family reported by native clients. */
  deviceFamily?: string;
  /** Hardware model identifier reported by native clients. */
  modelIdentifier?: string;
  /** PATH snapshot exposed by remote runtimes for requirement checks. */
  pathEnv?: string;
  /** Capability ids currently advertised by the node. */
  caps?: string[];
  /** Command ids currently advertised by the node. */
  commands?: string[];
  /** Effective operator permissions for the node. */
  permissions?: Record<string, boolean>;
  /** True when the node has an approved pairing record. */
  paired?: boolean;
  /** True when the node currently has a live connection. */
  connected?: boolean;
  /** Timestamp when the current connection was established. */
  connectedAtMs?: number;
  /** Timestamp of the latest observed presence or metadata update. */
  lastSeenAtMs?: number;
  /** Source/reason for the latest presence update. */
  lastSeenReason?: string;
  /** Timestamp when pairing was approved. */
  approvedAtMs?: number;
};

export type PendingRequest = {
  /** Pairing request id used by approval/rejection commands. */
  requestId: string;
  /** Node id requesting approval. */
  nodeId: string;
  /** User-facing node label captured at request time. */
  displayName?: string;
  /** Runtime platform reported by the requesting node. */
  platform?: string;
  /** Node application version reported by older clients. */
  version?: string;
  /** Core package version reported by the requesting node. */
  coreVersion?: string;
  /** UI package version reported by the requesting node. */
  uiVersion?: string;
  /** Remote address observed for the pending request. */
  remoteIp?: string;
  /** Request creation timestamp. */
  ts: number;
  /** Command ids requested or advertised during pairing. */
  commands?: string[];
  /** Operator scopes required to approve this request. */
  requiredApproveScopes?: Array<"operator.pairing" | "operator.write" | "operator.admin">;
};

export type PairedNode = {
  /** Stable node id approved for future connections. */
  nodeId: string;
  /** Stored pairing token; never include in user-facing list output. */
  token?: string;
  /** User-facing node label stored with the approval record. */
  displayName?: string;
  /** Last reported runtime platform. */
  platform?: string;
  /** Node application version reported by older clients. */
  version?: string;
  /** Last reported core package version. */
  coreVersion?: string;
  /** Last reported UI package version. */
  uiVersion?: string;
  /** Last observed remote address for the paired node. */
  remoteIp?: string;
  /** Approved operator permissions for the node. */
  permissions?: Record<string, boolean>;
  /** Timestamp when the pairing record was created. */
  createdAtMs?: number;
  /** Timestamp when pairing was approved. */
  approvedAtMs?: number;
  /** Timestamp when the node last established a connection. */
  lastConnectedAtMs?: number;
  /** Timestamp of the latest observed presence or metadata update. */
  lastSeenAtMs?: number;
  /** Source/reason for the latest presence update. */
  lastSeenReason?: string;
};

export type PairingList = {
  /** Pending node pairing requests. */
  pending: PendingRequest[];
  /** Approved paired nodes. */
  paired: PairedNode[];
};
