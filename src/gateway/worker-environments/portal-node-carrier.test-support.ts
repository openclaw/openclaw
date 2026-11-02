import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { NODE_WORKER_PORTAL_STREAM_VERSION } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import * as support from "./service.test-support.js";

export function deferredPortalValue<T>() {
  const deferred = createDeferredCore<T>();
  void deferred.promise.catch(() => undefined);
  return deferred;
}

export function portalNodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    ...createNodeWorkerBundleTestNode(),
    nodeId,
    pairingIdentity: "identity-1",
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 0 },
      portalStream: NODE_WORKER_PORTAL_STREAM_VERSION,
    },
  };
}

export function fakePortalBroker() {
  const ticket = "a".repeat(48);
  const attachments: Array<ReturnType<typeof deferredPortalValue<{ stream: PassThrough }>>> = [];
  const streams: PassThrough[] = [];
  const broker = {
    mintPortal: vi.fn(() => {
      const attached = deferredPortalValue<{ stream: PassThrough }>();
      attachments.push(attached);
      return {
        ticket,
        attachPath: `/node-portal/attach?ticket=${ticket}`,
        expiresAtMs: support.testState.nowMs + 60_000,
        attached: attached.promise,
        cancel: () => attached.reject(new Error("ticket cancelled")),
      };
    }),
  } as unknown as NodeDesktopStreamBroker;
  return {
    broker,
    attachNext() {
      const attached = expectDefined(attachments.shift(), "pending portal attach");
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
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
    const pending = createDeferredCore<InvokeResult>();
    completions.push(pending.resolve);
    const abort = () =>
      pending.resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
    if (request.signal?.aborted) {
      abort();
    } else {
      request.signal?.addEventListener("abort", abort, { once: true });
    }
    return await pending.promise;
  });
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
      const complete = expectDefined(completions.shift(), "active portal invocation");
      complete({ ok: false, error: { code: "DISCONNECTED", message: "node disconnected" } });
    },
  };
}
