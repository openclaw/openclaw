import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";
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

export function canReadSystemInfo(
  snapshot: ApplicationGatewaySnapshot | null | undefined,
): boolean {
  return canCallGatewayMethod(snapshot, "system.info", "operator.read");
}

export async function readSystemInfo(
  gateway: ApplicationGateway,
  signal?: AbortSignal,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<SystemInfoSample> {
  signal?.throwIfAborted();
  if (document.visibilityState === "hidden") {
    throw new DOMException("Page is hidden", "AbortError");
  }
  const { client, hello } = gateway.snapshot;
  let read = reads.get(gateway);
  if (!client || !canReadSystemInfo(gateway.snapshot)) {
    read?.controller.abort();
    reads.delete(gateway);
    throw new DOMException("System information is unavailable", "AbortError");
  }
  if (
    !read ||
    read.client !== client ||
    read.hello !== hello ||
    read.revision !== gateway.connectionRevision ||
    read.controller.signal.aborted ||
    (read.settled && (fresh || read.expiresAt <= Date.now()))
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
  const sample = await subscribeToSharedRequest(read, {}, signal);
  // A cached or transport-completed result still belongs to its admitted connection.
  // Recheck before exposure: scope changes can retire it while the request is pending.
  if (
    !canReadSystemInfo(gateway.snapshot) ||
    read.client !== gateway.snapshot.client ||
    read.hello !== gateway.snapshot.hello ||
    read.revision !== gateway.connectionRevision ||
    read.controller.signal.aborted
  ) {
    read.controller.abort();
    if (reads.get(gateway) === read) {
      reads.delete(gateway);
    }
    throw new DOMException("System information read was retired", "AbortError");
  }
  return sample;
}
