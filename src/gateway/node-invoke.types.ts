export type NodeInvokeParams = {
  nodeId: string;
  expectedConnId?: string;
  expectedPairingGeneration?: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  /** Process-local monotonic deadline inherited from invocation admission. */
  deadlineAtMs?: number;
  /** Inactivity deadline reset by each ordered progress chunk. */
  idleTimeoutMs?: number;
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
  idempotencyKey?: string;
  sessionKey?: string;
  /** Receives the id and armed hard deadline after a successful dispatch. */
  onDispatchReady?: (invokeId: string, deadlineAtMs?: number) => void;
  /** Revalidates caller authority at the registry-owned transport handoff. */
  isDispatchAuthorized?: () => boolean;
};

/** Result payload returned from node.invoke. */
export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};
