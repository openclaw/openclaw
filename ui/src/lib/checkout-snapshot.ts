import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "@openclaw/retry";
import type { ApplicationGateway } from "../app/gateway.ts";

/** Picker refreshes publish an invalidation to their requesting connection, never poll. */
export async function requestCheckoutSnapshot<T extends { refreshing?: boolean }>(
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe" | "subscribeEvents">,
  method: "worktrees.branches" | "projects.checkoutOptions",
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; onSnapshot?: (value: T) => void } = {},
): Promise<T> {
  const client = gateway.snapshot.client;
  if (!client || gateway.snapshot.phase !== "connected") {
    throw new Error("Gateway disconnected; reconnect to refresh checkout options.");
  }
  const connection = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, connection.signal])
    : connection.signal;
  const stopConnection = gateway.subscribe((snapshot) => {
    if (snapshot.client !== client || snapshot.phase !== "connected") {
      connection.abort();
    }
  });
  let changed = Promise.withResolvers<void>();
  const unsubscribe = gateway.subscribeEvents((event) => {
    const payload = event.payload;
    if (
      event.event === `${method}.changed` &&
      isRecord(payload) &&
      ["repoRoot", "projectId", "agentId"].every((key) => payload[key] === params[key])
    ) {
      changed.resolve();
    }
  });
  try {
    for (;;) {
      const result = await client.request<T>(method, params, { signal });
      signal.throwIfAborted();
      options.onSnapshot?.(result);
      if (!result.refreshing) {
        return result;
      }
      await raceWithTimeout(
        () => changed.promise,
        10_000,
        () => {
          throw new Error("Checkout refresh interrupted; select the project again to retry.");
        },
        { signal },
      );
      changed = Promise.withResolvers<void>();
    }
  } finally {
    unsubscribe();
    stopConnection();
  }
}
