import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type NodeSystemRunEventSource = {
  expectedTarget: SessionEventTarget;
  release: () => void;
};

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
  /** Host-bound source conversation, independent of the model session or node payload. */
  turnSource?: DeliveryContext;
  /** Host-only caller custody for delayed system.run notices; never forwarded to the node. */
  prepareSystemRunEventSource?: (
    sessionKey: string,
  ) => Promise<NodeSystemRunEventSource | undefined>;
  /** Receives the id and armed hard deadline after a successful dispatch. */
  onDispatchReady?: (invokeId: string, deadlineAtMs?: number) => void;
  /** Prepares durable approval authority after transport preparation, before the final guard. */
  authorizeDispatch?: () => Promise<boolean>;
  /** Revalidates caller authority at the registry-owned transport handoff. */
  isDispatchAuthorized?: () => boolean;
};

/** Result payload returned from node.invoke. */
export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string; details?: unknown } | null;
};
