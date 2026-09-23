import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

export const SYSTEM_INFO_POLL_INTERVAL_MS = 10_000;

type SystemInfoSample = {
  value: SystemInfoResult;
  at: number;
  roundTripMs: number;
};

type SystemInfoRead = {
  client: ApplicationGateway["snapshot"]["client"];
  hello: ApplicationGateway["snapshot"]["hello"];
  revision: number;
  expiresAt: number;
  settled: boolean;
  controller: AbortController;
  subscribers: Set<object>;
  promise: Promise<SystemInfoSample>;
};

// The transport hello is replaced on reconnect; credentials also advance the owner revision.
const reads = new WeakMap<ApplicationGateway, SystemInfoRead>();

export async function readSystemInfo(
  gateway: ApplicationGateway,
  signal?: AbortSignal,
): Promise<SystemInfoSample> {
  signal?.throwIfAborted();
  if (document.visibilityState === "hidden") {
    throw new DOMException("Page is hidden", "AbortError");
  }
  const { client, hello, phase } = gateway.snapshot;
  if (!client || phase !== "connected") {
    throw new DOMException("Gateway is disconnected", "AbortError");
  }
  let read = reads.get(gateway);
  if (
    !read ||
    read.client !== client ||
    read.hello !== hello ||
    read.revision !== gateway.connectionRevision ||
    read.controller.signal.aborted ||
    (read.settled && read.expiresAt <= Date.now())
  ) {
    read?.controller.abort();
    const controller = new AbortController();
    const startedAt = performance.now();
    const promise = client
      .request<SystemInfoResult>(
        "system.info",
        {},
        {
          signal: controller.signal,
          timeoutMs: SYSTEM_INFO_POLL_INTERVAL_MS,
        },
      )
      .then((value) => ({ value, at: Date.now(), roundTripMs: performance.now() - startedAt }));
    const next: SystemInfoRead = {
      client,
      hello,
      revision: gateway.connectionRevision,
      expiresAt: Date.now() + SYSTEM_INFO_POLL_INTERVAL_MS,
      settled: false,
      controller,
      subscribers: new Set(),
      promise,
    };
    void promise.then(
      () => {
        next.settled = true;
      },
      () => {
        if (reads.get(gateway) === next) {
          reads.delete(gateway);
        }
      },
    );
    reads.set(gateway, next);
    read = next;
  }
  return subscribeToSharedRequest(read, {}, signal);
}
