import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withCurrentSessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-current.js";
import type { SessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-types.js";
import { toErrorObject } from "../../infra/errors.js";
import {
  releaseSystemEventDeliveryAdoption,
  type DeliveryAdoptionTurnHold,
} from "../../infra/system-event-delivery-claims.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { consumeSelectedSystemEventEntries, type SystemEvent } from "../../infra/system-events.js";
import { captureContinuationQueueContext } from "../continuation/queue-context.js";
import {
  type ContinuationReturnRefusalStage,
  refuseContinuationReturnDelivery,
  reportRefusedContinuationReturn,
} from "../continuation/return-refusal.js";

type PreparedAuthorityScope = { agentId: string; sessionKey: string; storePath: string };
type PreparedAuthorityBinding = {
  authority: SessionRecipientAuthority;
  event: SystemEvent;
};
export type PreparedSystemEventAuthorityOwner = {
  scope: PreparedAuthorityScope;
  pending: Map<string, PreparedAuthorityBinding>;
};

export type PreparedSystemEventBlock = {
  key?: string;
  text: string;
  authorityKey?: string;
};

export type PreparedManagedSystemEventDelivery = {
  id: string;
  acknowledge: () => Promise<void>;
  /** Re-queue the consumed event when its turn ends without adoption. */
  restore?: () => void;
  /** Adopted by a turn whose staged user message cannot carry the ack id. */
  adoptedWithoutReceipt?: boolean;
  authorityKey?: string;
  /** Keeps the delivery's adoption claim alive while the adopting turn is in flight. */
  turnHold?: DeliveryAdoptionTurnHold;
};

export type PreparedFormattedSystemEvents = {
  blocks: PreparedSystemEventBlock[];
  managedDeliveries: PreparedManagedSystemEventDelivery[];
  authorityOwner?: PreparedSystemEventAuthorityOwner;
};

const MESSAGE_METADATA_KEY = "__openclaw";

function readSessionDeliveryAckIds(message: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(message)) {
    return ids;
  }
  const metadata = message[MESSAGE_METADATA_KEY];
  if (!isRecord(metadata) || !Array.isArray(metadata.sessionDeliveryAckIds)) {
    return ids;
  }
  for (const id of metadata.sessionDeliveryAckIds) {
    const normalized = normalizeOptionalString(id);
    if (normalized) {
      ids.add(normalized);
    }
  }
  return ids;
}

export function readAdoptedSystemEventDeliveryIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (isRecord(event)) {
      for (const id of readSessionDeliveryAckIds(event.message)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

async function acknowledgePersistedManagedSystemEvents(params: {
  deliveries: Iterable<PreparedManagedSystemEventDelivery>;
  persistedMessage: unknown;
}): Promise<void> {
  const adoptedIds = readSessionDeliveryAckIds(params.persistedMessage);
  let firstError: Error | undefined;
  for (const delivery of params.deliveries) {
    if (!delivery.adoptedWithoutReceipt && !adoptedIds.has(delivery.id)) {
      continue;
    }
    try {
      await delivery.acknowledge();
    } catch (error) {
      firstError ??= toErrorObject(error, "Managed session delivery acknowledgement failed");
    }
  }
  if (firstError) {
    throw firstError;
  }
}

export async function settleManagedSystemEventsAfterTurnAdoption(params: {
  deliveries: Iterable<PreparedManagedSystemEventDelivery>;
  persistedMessage: unknown;
  onTurnAdopted?: () => void | Promise<void>;
}): Promise<void> {
  // Tombstone the ingress claim first. Delivery settlement can replay from the
  // transcript receipt; an untombstoned claim can replay the injected turn.
  await params.onTurnAdopted?.();
  await acknowledgePersistedManagedSystemEvents(params);
}

/** Refuses an event whose recipient authority advanced: its row is retired unadopted, never acked. */
export async function settleStaleSystemEventAuthority(params: {
  event: SystemEvent;
  sessionKey: string;
  /** Owner that selected this event; omitted when sessionKey is already a queue key. */
  ownerAgentId?: string;
  stage: Extract<ContinuationReturnRefusalStage, "wake" | "prompt-drain">;
}): Promise<void> {
  const deliveryId = params.event.sessionDeliveryAckId;
  if (deliveryId) {
    await refuseContinuationReturnDelivery(
      deliveryId,
      captureContinuationQueueContext(params.event.sessionDeliveryAckStateDir),
    );
    // Retired, not adopted: no replay may queue it again in this process.
    releaseSystemEventDeliveryAdoption(params.event, { settled: true });
  }
  // Resolved here rather than at each call site so a third caller cannot forget:
  // an already-qualified key resolves to itself, and a supplied owner is verified
  // against the key instead of overriding it.
  consumeSelectedSystemEventEntries(
    resolveSystemEventQueueKey(params.sessionKey, params.ownerAgentId),
    [params.event],
  );
  reportRefusedContinuationReturn({
    stage: params.stage,
    reason: "recipient-authority-changed",
    sessionKey: params.sessionKey,
    ...(deliveryId ? { deliveryId } : {}),
  });
}

export function readPreparedSystemEventAuthorityKey(event: SystemEvent): string | undefined {
  const key = event.recipientAuthority ? (event.id ?? event.sessionDeliveryAckId) : undefined;
  if (event.recipientAuthority && !key) {
    throw new Error("authority-bound system event is missing queue identity");
  }
  return key;
}

export function createPreparedSystemEventAuthorityOwner(params: {
  scope: PreparedAuthorityScope;
  events: readonly SystemEvent[];
}): PreparedSystemEventAuthorityOwner | undefined {
  const pending = new Map<string, PreparedAuthorityBinding>();
  for (const event of params.events) {
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    if (authorityKey && event.recipientAuthority) {
      pending.set(authorityKey, {
        authority: event.recipientAuthority,
        event,
      });
    }
  }
  return pending.size > 0 ? { scope: params.scope, pending } : undefined;
}

type StaleAuthorityBinding = {
  authorityKey: string;
  binding: PreparedAuthorityBinding;
  owner: PreparedSystemEventAuthorityOwner;
};

type FinalSystemEventAdoptionParams = {
  prepared: readonly PreparedFormattedSystemEvents[];
  replaceDeliveryIds?: (deliveryIds: readonly string[]) => boolean;
};

export type AdoptedSystemEvents = {
  kind: "adopted";
  blocks: PreparedSystemEventBlock[];
  managedDeliveries: Map<string, PreparedManagedSystemEventDelivery>;
};

function decideFinalSystemEventAdoption(
  params: FinalSystemEventAdoptionParams,
  stale: readonly StaleAuthorityBinding[],
) {
  if (stale.length > 0) {
    return {
      kind: "settle-stale" as const,
      settle: async () => {
        for (const entry of stale) {
          // Settlement stays bound to the owner that selected this exact queue
          // event; a replacement session cannot redirect it.
          await settleStaleSystemEventAuthority({
            event: entry.binding.event,
            sessionKey: entry.owner.scope.sessionKey,
            ownerAgentId: entry.owner.scope.agentId,
            stage: "prompt-drain",
          });
          entry.owner.pending.delete(entry.authorityKey);
        }
      },
    };
  }

  const isAdoptable = (prepared: PreparedFormattedSystemEvents, authorityKey: string | undefined) =>
    !authorityKey || prepared.authorityOwner?.pending.has(authorityKey);
  const adoptedDeliveries = new Map(
    params.prepared.flatMap((prepared) =>
      prepared.managedDeliveries
        .filter((delivery) => isAdoptable(prepared, delivery.authorityKey))
        .map((delivery) => [delivery.id, delivery] as const),
    ),
  );
  const deliveryIds = [...adoptedDeliveries.keys()];
  const recorderAccepted = params.replaceDeliveryIds?.(deliveryIds) ?? true;
  const deferredBlockKeys = recorderAccepted
    ? undefined
    : new Set(deliveryIds.map((id) => `session-delivery:${id}`));

  return {
    kind: "adopted" as const,
    blocks: params.prepared.flatMap((prepared) =>
      prepared.blocks.filter(
        (block) =>
          isAdoptable(prepared, block.authorityKey) && !deferredBlockKeys?.has(block.key ?? ""),
      ),
    ),
    managedDeliveries: recorderAccepted
      ? adoptedDeliveries
      : new Map<string, PreparedManagedSystemEventDelivery>(),
  } satisfies AdoptedSystemEvents;
}

/**
 * The final adoption decision. Recipient authority is read in the sharing worker, and the
 * decision (with `onAdopted`, when given) runs under the same writer admission, so no
 * revocation can commit between the read and the adoption it allows.
 */
export async function resolveFinalSystemEventAdoption(
  params: FinalSystemEventAdoptionParams & { onAdopted?: (adoption: AdoptedSystemEvents) => void },
) {
  const bound: StaleAuthorityBinding[] = params.prepared.flatMap((prepared) => {
    const owner = prepared.authorityOwner;
    return owner
      ? [...owner.pending].map(([authorityKey, binding]) => ({ authorityKey, binding, owner }))
      : [];
  });
  return await withCurrentSessionRecipientAuthority(
    bound.map(({ owner, binding }) => ({ scope: owner.scope, authority: binding.authority })),
    (current) => {
      const adoption = decideFinalSystemEventAdoption(
        params,
        bound.filter((_, index) => !current[index]),
      );
      if (adoption.kind === "adopted") {
        params.onAdopted?.(adoption);
      }
      return adoption;
    },
  );
}

/**
 * Adopts one prepared drain into the turn being admitted: settles stale recipient authority until
 * none remains, records the adopted managed deliveries, and appends each block not already
 * appended under the same key.
 */
export async function adoptPreparedSystemEvents(params: {
  prepared: PreparedFormattedSystemEvents;
  recorder?: { replaceSessionDeliveryAckIds?: (deliveryIds: readonly string[]) => boolean };
  managedDeliveries: Map<string, PreparedManagedSystemEventDelivery>;
  seenBlockKeys: Set<string>;
  blocks: Array<{ key?: string; text: string }>;
}): Promise<void> {
  // Applied inside the authority decision, before its writer admission releases.
  const onAdopted = (adoption: AdoptedSystemEvents) => {
    const managedDeliveryIds = [...adoption.managedDeliveries.keys()];
    const recorderAccepted =
      !params.recorder ||
      params.recorder.replaceSessionDeliveryAckIds?.(managedDeliveryIds) === true;
    // A staged recorder cannot carry the ack ids. Deferring would drop the
    // return until gateway restart, so adopt it in this turn without a
    // transcript receipt; settlement acks it on adoption (at-least-once).
    for (const [id, delivery] of adoption.managedDeliveries) {
      params.managedDeliveries.set(
        id,
        recorderAccepted ? delivery : { ...delivery, adoptedWithoutReceipt: true },
      );
    }
    for (const block of adoption.blocks) {
      if (block.key) {
        if (params.seenBlockKeys.has(block.key)) {
          continue;
        }
        params.seenBlockKeys.add(block.key);
      }
      params.blocks.push(block);
    }
  };
  let adoption = await resolveFinalSystemEventAdoption({ prepared: [params.prepared], onAdopted });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = await resolveFinalSystemEventAdoption({ prepared: [params.prepared], onAdopted });
  }
}
