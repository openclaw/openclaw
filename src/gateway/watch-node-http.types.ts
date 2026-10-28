import type { ServerResponse } from "node:http";

export type QueuedNodeEvent = { json: string; byteLength: number };

export type WatchNodeSession = {
  token: string;
  nodeId: string;
  connId: string;
  invalidatedReason?: string;
  lastSeenAtMs: number;
  expiresTimer?: ReturnType<typeof setTimeout>;
  queue: QueuedNodeEvent[];
  queuedBytes: number;
  waiter?: {
    res: ServerResponse;
    timer: ReturnType<typeof setTimeout>;
  };
};
