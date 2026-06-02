export type NodesRpcOpts = {
  /** Gateway WebSocket URL override for commands that should not use config discovery. */
  url?: string;
  /** Gateway token override passed directly to the RPC transport. */
  token?: string;
  /** Transport timeout in milliseconds as accepted by Commander options. */
  timeout?: string;
  /** Emit raw JSON and suppress progress/table rendering. */
  json?: boolean;
  /** Node id, display name, or resolver query supplied by node subcommands. */
  node?: string;
  /** Node-side command name for `nodes invoke`. */
  command?: string;
  /** JSON object payload string for node-side command invocation. */
  params?: string;
  /** Node-side command timeout in milliseconds, distinct from transport timeout. */
  invokeTimeout?: string;
  /** Optional caller-provided idempotency key for retry-safe node invocation. */
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

export type { NodeListNode, PairedNode, PendingRequest } from "../../shared/node-list-types.js";
