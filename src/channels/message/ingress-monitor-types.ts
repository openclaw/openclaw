import type { ChannelIngressQueueClaim } from "./ingress-queue.js";

/** Stable identity and serialization lane extracted before durable admission. */
export type ChannelIngressMonitorFacts = { eventId: string; laneKey: string };

/** Versioned body presented to a channel's persisted-payload encoder. */
type ChannelIngressPayloadEnvelope<TBody> = { version: number; body: TBody };

/** Claim ownership lifecycle handed to one channel delivery. */
export type ChannelIngressMonitorLifecycle = {
  admission: "exclusive";
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onDeferredHeartbeat?: () => void;
  onAdoptionFinalizing: () => void;
  onFailed?: (error: unknown) => void | Promise<void>;
  onCancelled?: () => void | Promise<void>;
  onAbandoned: () => void | Promise<void>;
};

/** Optional explicit outcome from a channel delivery. */
export type ChannelIngressMonitorDeliveryResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type ChannelIngressMonitorInspectionContext =
  | { phase: "admission" }
  | { phase: "claim"; claimedId: string; claimedLaneKey: string | undefined };

export type ChannelIngressMonitorRetention = {
  pruneIntervalMs: number;
  pendingTtlMs?: number;
  pendingMaxEntries?: number;
  completedTtlMs?: number;
  completedMaxEntries?: number;
  failedTtlMs?: number;
  failedMaxEntries?: number;
};

type ChannelIngressMonitorClaimErrorKind = "invalid-version" | "identity-mismatch";

export type ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata> = {
  version: number;
  serialize: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number },
  ) => TBody;
  deserialize: (
    body: TBody,
    context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
  ) => TRaw;
  createClaimError: (
    kind: ChannelIngressMonitorClaimErrorKind,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) => Error;
} & (
  | (TBody extends string ? { storage: "raw-event" } : never)
  | {
      storage?: "custom";
      encode: (envelope: ChannelIngressPayloadEnvelope<TBody>) => TStoredPayload;
      decode: (
        payload: TStoredPayload,
        context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
      ) => { version: unknown; body: TBody };
    }
);
