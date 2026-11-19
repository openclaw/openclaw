import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../../api/types.ts";

const INVENTORY_CHANGED = "cron.inventory.changed";
const inventories = new WeakMap<GatewayBrowserClient, Inventory>();
export type Runtime = {
  revision: number;
  jobId: string;
  action: "started" | "finished" | "scheduled";
  job: Pick<CronJob, "id" | "name" | "agentId" | "enabled" | "updatedAtMs" | "state">;
  error?: string;
  durationMs?: number;
};
type Subscriber = { canRead: () => boolean };
export type Entry<Row> = {
  version: number;
  applyRuntime: (runtime: Runtime) => void;
  value?: CronJobsListResult<Row>;
  pending?: {
    promise: Promise<CronJobsListResult<Row>>;
    controller: AbortController;
    subscribers: Set<Subscriber>;
  };
};
export type Inventory = {
  hello: GatewayHelloOk | null;
  supported: boolean;
  version: number;
  compact: Map<string, Entry<CronCompactJob>>;
  full: Map<string, Entry<CronJob>>;
  runtime: Map<string, Runtime>;
  runtimeRevision: number;
  debounce?: { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> };
};

export function hasCronInventoryEvents(snapshot: { hello?: GatewayHelloOk | null }): boolean {
  return snapshot.hello?.features?.events?.includes(INVENTORY_CHANGED) === true;
}

export function usesCronInventoryEvents(client: GatewayBrowserClient): boolean {
  return inventories.get(client)?.supported === true;
}

export function isCronInventoryInvalidation(
  event: GatewayEventFrame,
  snapshot: { hello?: GatewayHelloOk | null },
): boolean {
  return (
    event.event === INVENTORY_CHANGED ||
    event.event === "config.changed" ||
    (event.event === "sessions.changed" &&
      isRecord(event.payload) &&
      ["sharing", "profile-identity", "delete", "reset", "archive"].includes(
        String(event.payload.reason),
      )) ||
    (event.event === "cron" && !hasCronInventoryEvents(snapshot))
  );
}

/** Hello and disconnect publications retire data before any consumer can reuse it. */
export function bindCronInventory(client: GatewayBrowserClient, hello: GatewayHelloOk | null) {
  if (inventories.get(client)?.hello === hello) {
    return;
  }
  clearCronInventory(client);
  inventories.set(client, {
    hello,
    supported: hasCronInventoryEvents({ hello }),
    version: 0,
    compact: new Map(),
    full: new Map(),
    runtime: new Map(),
    runtimeRevision: 0,
  });
}

export function clearCronInventory(client: GatewayBrowserClient): void {
  const owner = inventories.get(client);
  inventories.delete(client);
  if (owner?.debounce) {
    clearTimeout(owner.debounce.timer);
    owner.debounce.resolve();
  }
  for (const entry of [...(owner?.compact.values() ?? []), ...(owner?.full.values() ?? [])]) {
    entry.pending?.controller.abort();
  }
}

function invalidateCronInventory(client: GatewayBrowserClient): void {
  const owner = inventories.get(client);
  if (!owner) {
    return;
  }
  owner.version += 1;
  owner.runtime.clear();
  if (owner.supported && !owner.debounce) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      owner.debounce = undefined;
      resolve();
    }, 50);
    owner.debounce = { promise, resolve, timer };
  }
}

/** Called once by the Gateway event owner, before events reach view subscribers. */
export function receiveCronInventoryEvent(client: GatewayBrowserClient, event: GatewayEventFrame) {
  const owner = inventories.get(client);
  if (!owner) {
    return;
  }
  if (isCronInventoryInvalidation(event, { hello: owner.hello })) {
    invalidateCronInventory(client);
  } else if (owner.supported && event.event === "cron") {
    const payload = event.payload;
    if (
      !isRecord(payload) ||
      !["started", "finished", "scheduled"].includes(String(payload.action)) ||
      !isRecord(payload.job) ||
      !isRecord(payload.job.state) ||
      payload.jobId !== payload.job.id
    ) {
      return;
    }
    const runtime = {
      // SAFETY: The authenticated cron publisher owns this bounded runtime projection.
      ...(payload as Omit<Runtime, "revision">),
      revision: ++owner.runtimeRevision,
    };
    owner.runtime.delete(runtime.jobId);
    owner.runtime.set(runtime.jobId, runtime);
    // Keep only recent run facts for responses crossing an event; definitions retire them.
    if (owner.runtime.size > 512) {
      owner.runtime.delete(owner.runtime.keys().next().value!);
    }
    for (const entry of [...owner.compact.values(), ...owner.full.values()]) {
      entry.applyRuntime(runtime);
    }
  }
}

export function getCronInventory(client: GatewayBrowserClient): Inventory {
  if (!inventories.has(client)) {
    bindCronInventory(client, null);
  }
  return inventories.get(client)!;
}

export function isCurrentCronInventory(client: GatewayBrowserClient, owner: Inventory): boolean {
  return inventories.get(client) === owner;
}
