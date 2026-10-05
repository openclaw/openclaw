import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import type { GatewayReadSharing } from "./methods/descriptor.js";
import { SerializedJsonPayload } from "./serialized-json.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { withPreparedGatewayRead } from "./server-methods/prepared-read.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestContext,
  RespondFn,
} from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

type Response = Parameters<RespondFn>;
type Entry = {
  handler: GatewayRequestHandler;
  sharing: GatewayReadSharing;
  expires: number;
  current: () => boolean;
  publishRows: () => void;
  result?: Response;
  settled: Promise<void>;
  settle: () => void;
  retire: () => void;
};
const owners = new WeakMap<GatewayBroadcastFn, Map<string, Entry>>();
const MAX_ENTRIES = 16;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_AGE_MS = 5_000;

/** Retire in-flight work before the event can cause a new client read. */
export function invalidateSharedReadResponses(owner: GatewayBroadcastFn, event?: string): void {
  const entries = owners.get(owner);
  for (const entry of entries?.values() ?? []) {
    if (event === undefined || entry.sharing.shareInvalidationEvents.includes(event)) {
      entry.retire();
    }
  }
}

function captureRevision(context: GatewayRequestContext): Pick<Entry, "current" | "publishRows"> {
  const config = context.getRuntimeConfig();
  const policy = context.getCommittedRuntimeConfig?.();
  const access = readGatewayAccessRevision();
  const projection = getSessionRowProjection(context);
  const runners = context.workerPlacementRunnerAvailabilityReader;
  const runnerRevision = runners?.version();
  let rows = projection?.sharingRevision;
  return {
    publishRows: () => {
      rows = projection?.sharingRevision;
    },
    current: () =>
      context.getRuntimeConfig() === config &&
      context.getCommittedRuntimeConfig?.() === policy &&
      readGatewayAccessRevision() === access &&
      getSessionRowProjection(context) === projection &&
      context.workerPlacementRunnerAvailabilityReader === runners &&
      runners?.version() === runnerRevision &&
      projection?.sharingRevision === rows,
  };
}

function createEntry(
  entries: Map<string, Entry>,
  key: string,
  facts: Pick<Entry, "handler" | "sharing" | "current" | "publishRows">,
): Entry {
  // Cached promises and expiry timers must not retain the producer's request authority.
  return runInDetachedAsyncContext(() => {
    const completion = createDeferredCore();
    const duration = Math.min(facts.sharing.shareMaxAgeMs, MAX_AGE_MS);
    const entry: Entry = {
      ...facts,
      expires: Date.now() + duration,
      settled: completion.promise,
      settle: completion.resolve,
      retire: () => {
        clearTimeout(timer);
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
        completion.resolve();
      },
    };
    const timer = setTimeout(entry.retire, duration);
    timer.unref();
    entries.set(key, entry);
    return entry;
  });
}

/** Share only a method-declared read, after each caller prepares its own authority. */
export async function dispatchSharedRead(
  handler: GatewayRequestHandler,
  options: GatewayRequestHandlerOptions,
  sharing: GatewayReadSharing,
  assertCurrent: () => void,
): Promise<void> {
  const owner = options.context.broadcast;
  let entries = owners.get(owner);
  if (!entries) {
    entries = new Map();
    owners.set(owner, entries);
  }
  await withPreparedGatewayRead(handler, options, async (read) => {
    const deliver: RespondFn = (...response) => {
      assertCurrent();
      if (response[0]) {
        read.assertCurrent?.();
        read.beforeRespond?.();
      }
      (read.respond ?? options.respond)(...response);
    };
    const caller = {
      client: options.client,
      read: { shareable: read.shareable },
    };
    const shareKey = sharing.shareKey(caller, options.params);
    assertCurrent();
    if (shareKey === null) {
      await read.run(deliver);
      return;
    }
    read.assertCurrent?.();
    const key = JSON.stringify([options.req.method, shareKey]);
    const existing = entries.get(key);
    const valid = (entry: Entry) =>
      entry.handler === handler &&
      entry.sharing.shareKey === sharing.shareKey &&
      entries.get(key) === entry &&
      entry.expires > Date.now() &&
      entry.current();
    if (existing && valid(existing)) {
      await racePromiseWithAbortSignal(existing.settled, options.signal);
      if (
        existing.result &&
        valid(existing) &&
        sharing.shareKey(caller, options.params) === shareKey
      ) {
        deliver(...existing.result);
      } else {
        // A retired or failed producer must not turn a slow burst into serial retries.
        assertCurrent();
        read.assertCurrent?.();
        await read.run(deliver);
      }
      return;
    }
    existing?.retire();
    for (const entry of entries.values()) {
      if (entry.expires <= Date.now() || entries.size >= MAX_ENTRIES) {
        entry.retire();
      }
    }
    const entry = createEntry(entries, key, {
      handler,
      sharing,
      ...captureRevision(options.context),
    });
    try {
      await read.run((...response) => {
        assertCurrent();
        if (response[0]) {
          read.assertCurrent?.();
          // Row preparation may advance its own publication. Config/access fences
          // still belong to admission, and encoding may itself execute toJSON.
          entry.publishRows();
          const payload = new SerializedJsonPayload(response[1]);
          response[1] = payload;
          if (valid(entry) && payload.bytes.byteLength <= MAX_PAYLOAD_BYTES) {
            entry.result = response;
          }
        }
        deliver(...response);
      });
    } finally {
      if (!entry.result) {
        entry.retire();
      }
      entry.settle();
    }
  });
}
