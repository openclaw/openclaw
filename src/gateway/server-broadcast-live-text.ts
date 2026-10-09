import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isLiveTextAppend } from "./live-text-continuity.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const log = createSubsystemLogger("gateway/broadcast");
type LiveText = NonNullable<GatewayBroadcastOpts["liveText"]>;

export type LiveTextPublication = {
  key: string;
  sourceEpoch?: object;
  previous?: object;
  revision: object;
  version?: unknown;
  snapshot?: boolean;
  text?: string;
};
export type PendingLiveText = {
  group: AbortSignal;
  key: string;
  payload: unknown;
  bytes: number;
  isCurrent?: () => boolean;
  publication?: LiveTextPublication;
  send: () => void;
};
type LiveTextReceipt = {
  revision: object;
  version?: unknown;
  sessionKeys: readonly string[];
};
type LiveTextGroup = {
  entries: Map<string, PendingLiveText>;
  receipts: Map<string, LiveTextReceipt>;
  retire: () => void;
};
type ClientDelivery = {
  socket: GatewayConnectionTransport;
  retired: boolean;
  inFlight: number;
  draining: boolean;
  bytes: number;
  groups: Map<AbortSignal, LiveTextGroup>;
  pending: Set<PendingLiveText>;
  close?: () => void;
};

/** Socket-owned queues and receipts share the run's retirement and subscription lifecycle. */
export function createGatewayLiveTextDelivery(params: {
  clients: GatewayClientRegistry;
  sessionMessageSubscribers?: SessionMessageSubscriberRegistry;
}) {
  const deliveries = new WeakMap<GatewayWsClient, ClientDelivery>();
  const publications = new WeakMap<AbortSignal, Map<string, LiveTextPublication>>();
  const deliveryFor = (client: GatewayWsClient) => {
    let state = deliveries.get(client);
    if (!state || state.socket !== client.socket) {
      if (state) {
        retireDelivery(state);
      }
      state = {
        socket: client.socket,
        retired: false,
        inFlight: 0,
        draining: false,
        bytes: 0,
        groups: new Map(),
        pending: new Set(),
      };
      deliveries.set(client, state);
    }
    return state;
  };
  // Pending text and socket writes share the connection budget and upstream backpressure.
  const bufferedBytes = (state: ClientDelivery) => state.socket.bufferedAmount + state.bytes;
  const takePending = (state: ClientDelivery, entry: PendingLiveText) => {
    state.pending.delete(entry);
    const group = state.groups.get(entry.group)!;
    group.entries.delete(entry.key);
    if (!group.entries.size && !group.receipts.size) {
      entry.group.removeEventListener("abort", group.retire);
      state.groups.delete(entry.group);
    }
    state.bytes -= entry.bytes;
  };
  const retireDelivery = (state: ClientDelivery) => {
    state.retired = true;
    for (const [signal, group] of state.groups) {
      signal.removeEventListener("abort", group.retire);
    }
    state.groups.clear();
    state.pending.clear();
    state.bytes = 0;
    if (state.close) {
      state.socket.off("close", state.close);
      state.close = undefined;
    }
  };
  const groupFor = (state: ClientDelivery, signal: AbortSignal) => {
    if (!state.close) {
      state.close = () => retireDelivery(state);
      state.socket.once("close", state.close);
    }
    let group = state.groups.get(signal);
    if (!group) {
      const entries = new Map<string, PendingLiveText>();
      const receipts = new Map<string, LiveTextReceipt>();
      const retire = () => {
        receipts.clear();
        for (const pending of entries.values()) {
          takePending(state, pending);
        }
        state.groups.delete(signal);
      };
      group = { entries, receipts, retire };
      state.groups.set(signal, group);
      signal.addEventListener("abort", retire, { once: true });
    }
    return group;
  };
  params.sessionMessageSubscribers?.onChange((sessionKey, connId) => {
    const client = params.clients.getByConnectionId(connId);
    const state = client && deliveries.get(client);
    for (const group of state?.groups.values() ?? []) {
      for (const [key, receipt] of group.receipts) {
        if (receipt.sessionKeys.includes(sessionKey)) {
          group.receipts.delete(key);
        }
      }
    }
  });
  const drain = (state: ClientDelivery, group?: AbortSignal) => {
    if (state.retired || state.draining) {
      return;
    }
    state.draining = true;
    try {
      // A barrier may overtake in-flight writes, but never another group's queue.
      // The guard also contains synchronous send callbacks without recursive drains.
      for (const entry of state.pending) {
        if (group ? entry.group !== group : state.inFlight !== 0) {
          if (group) {
            continue;
          }
          break;
        }
        takePending(state, entry);
        try {
          entry.send();
        } catch (err) {
          log.error(`broadcast pending send failed: ${formatErrorMessage(err)}`);
        }
      }
    } finally {
      state.draining = false;
    }
  };
  const publish = (live: LiveText | undefined) => {
    if (!live?.projection || live.group.aborted) {
      return undefined;
    }
    let streams = publications.get(live.group);
    if (!streams) {
      streams = new Map();
      publications.set(live.group, streams);
      live.group.addEventListener("abort", () => publications.delete(live.group), { once: true });
    }
    const latest = streams.get(live.projection.key);
    const previous = latest?.sourceEpoch === live.sourceEpoch ? latest : undefined;
    const publication: LiveTextPublication = {
      key: live.projection.key,
      sourceEpoch: live.sourceEpoch,
      previous: previous?.revision,
      revision: {},
      version: live.projection.version,
      text: live.projection.text?.snapshot,
      snapshot:
        live.projection.snapshot ||
        !Object.is(previous?.version, live.projection.version) ||
        (live.projection.text !== undefined &&
          !isLiveTextAppend(previous?.text, live.projection.text)),
    };
    streams.set(publication.key, publication);
    return publication;
  };

  return {
    deliveryFor,
    bufferedBytes,
    takePending,
    retireDelivery,
    drain,
    publish,
    pending: (state: ClientDelivery, group: AbortSignal, key: string) =>
      state.groups.get(group)?.entries.get(key),
    enqueue: (state: ClientDelivery, entry: PendingLiveText) => {
      groupFor(state, entry.group).entries.set(entry.key, entry);
      state.pending.add(entry);
      state.bytes += entry.bytes;
    },
    coalescePublication: (publication?: LiveTextPublication, previous?: LiveTextPublication) =>
      publication && {
        ...publication,
        previous: previous ? previous.previous : publication.previous,
        snapshot:
          publication.snapshot ||
          previous?.snapshot ||
          (previous !== undefined && previous.revision !== publication.previous),
      },
    canSendDelta: (state: ClientDelivery, live?: LiveText, publication?: LiveTextPublication) => {
      const receipt =
        publication && live && state.groups.get(live.group)?.receipts.get(publication.key);
      return Boolean(
        publication &&
        receipt &&
        receipt.revision === publication.previous &&
        Object.is(receipt.version, publication.version) &&
        !publication.snapshot,
      );
    },
    recordReceipt: (
      state: ClientDelivery,
      sessionKeys: readonly string[],
      live?: LiveText,
      publication?: LiveTextPublication,
    ) => {
      if (publication && live && !live.group.aborted) {
        groupFor(state, live.group).receipts.set(publication.key, {
          revision: publication.revision,
          version: publication.version,
          sessionKeys,
        });
      }
    },
  };
}
