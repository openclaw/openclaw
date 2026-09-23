import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import * as support from "./service.test-support.js";

export function deferredPortalValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

export function portalNodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 0 },
      portalStream: NODE_WORKER_PORTAL_STREAM_VERSION,
    },
    commands: [],
  };
}

export function fakePortalBroker() {
  const attachments: Array<ReturnType<typeof deferredPortalValue<{ stream: PassThrough }>>> = [];
  const streams: PassThrough[] = [];
  const broker = {
    mintPortal: vi.fn(() => {
      const attached = deferredPortalValue<{ stream: PassThrough }>();
      attachments.push(attached);
      return {
        ticket: "a".repeat(48),
        attachPath: `/node-portal/attach?ticket=${"a".repeat(48)}`,
        expiresAtMs: support.testState.nowMs + 60_000,
        attached: attached.promise,
        cancel: () => attached.reject(new Error("ticket cancelled")),
      };
    }),
  } as unknown as NodeDesktopStreamBroker;
  return {
    broker,
    attachNext() {
      const attached = attachments.shift();
      if (!attached) {
        throw new Error("expected pending portal attach");
      }
      const stream = new PassThrough();
      streams.push(stream);
      attached.resolve({ stream });
      return stream;
    },
    streams,
  };
}

export function pendingPortalTransport(params: {
  proof: NodeWorkerSupervisorNodeProof;
  isProofCurrent: () => boolean;
}) {
  type InvokeResult = Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;
  const completions: Array<(result: InvokeResult) => void> = [];
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
    async (request) =>
      await new Promise((resolve) => {
        completions.push(resolve);
        const abort = () =>
          resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
        if (request.signal?.aborted) {
          abort();
        } else {
          request.signal?.addEventListener("abort", abort, { once: true });
        }
      }),
  );
  const transport: NodeWorkerSupervisorTransport = {
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((node) => node.nodeId === nodeId);
    },
    listCurrentNodes: async () => [params.proof],
    hasCurrentRunner: (nodeId) => nodeId === params.proof.nodeId && params.isProofCurrent(),
    isCurrent: () => params.isProofCurrent(),
    invoke,
  };
  return {
    invoke,
    transport,
    dropNext() {
      const complete = completions.shift();
      if (!complete) {
        throw new Error("expected active portal invocation");
      }
      complete({ ok: false, error: { code: "DISCONNECTED", message: "node disconnected" } });
    },
  };
}
