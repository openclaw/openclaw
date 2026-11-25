import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import type { ChannelIngressDrainDispatchResult } from "./ingress-drain-state.js";
import type { CreateChannelIngressDrainOptions } from "./ingress-drain.js";
import type { ChannelIngressQueue, ChannelIngressQueueClaim } from "./ingress-queue.js";

/** Stable identity and serialization lane extracted before durable admission. */
export type ChannelIngressMonitorFacts = { eventId: string; laneKey: string };

/** Versioned body presented to a channel's persisted-payload encoder. */
type ChannelIngressPayloadEnvelope<TBody> = { version: number; body: TBody };

/** Claim ownership lifecycle handed to one channel delivery. */
export type ChannelIngressMonitorLifecycle = ChannelIngressDispatchLifecycle & {
  admission: "exclusive";
};

export type ChannelIngressMonitorDeliveryResult = ChannelIngressDrainDispatchResult;

export type ChannelIngressMonitorAdmissionResult<TResult> =
  | { readonly kind: "ignored"; readonly queueResult?: undefined }
  | { readonly kind: "durable"; readonly queueResult: TResult };

type ChannelIngressMonitorInspectionContext =
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

export type ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata> = Omit<
  CreateChannelIngressDrainOptions<TStoredPayload, TMetadata>,
  "queue" | "dispatchClaimedEvent" | "abortSignal" | "now" | "ownerId" | "claimLeaseMs"
>;

export type CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata> = {
  queue:
    | ChannelIngressQueue<TStoredPayload, TMetadata>
    | (() => ChannelIngressQueue<TStoredPayload, TMetadata>);
  inspect: (
    raw: TRaw,
    context: ChannelIngressMonitorInspectionContext,
  ) => ChannelIngressMonitorFacts | null;
  /** Preferred over inspect when the host supports asynchronous inspection. */
  inspectAsync?: (
    raw: TRaw,
    context: ChannelIngressMonitorInspectionContext,
  ) => Promise<ChannelIngressMonitorFacts | null>;
  /** Await a provider-validated replacement before serialization; policy errors refuse intake. */
  prepareAdmission?: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number; signal: AbortSignal },
  ) => Promise<{ raw: TRaw; assertCurrent: () => void } | undefined>;
  payload: ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata>;
  /**
   * Reuse admission identity when this monitor appends and claims a fresh event.
   * Payload deserialization still runs; claim inspection must not prepare delivery
   * data or authorize effects. Replayed and previously stored events still inspect.
   */
  reuseAdmissionFactsForFreshClaims?: boolean;
  deliver: (
    raw: TRaw,
    lifecycle: ChannelIngressMonitorLifecycle,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) =>
    | Promise<ChannelIngressMonitorDeliveryResult | void>
    | ChannelIngressMonitorDeliveryResult
    | void;
  /**
   * Recovery sweep interval (minimum five minutes); admissions and retries wake directly.
   * External queue writes, including CLI resubmission, do not wake this monitor.
   * Eligible rows wait up to the effective interval; an unrefreshed live-process claim first
   * expires its lease (30 minutes by default). Startup recovery runs immediately.
   */
  pollIntervalMs: number;
  retention: "standard" | Partial<ChannelIngressMonitorRetention>;
  appendRetryDelaysMs?: readonly number[];
  /**
   * Runs after every durable enqueue. `isNew` means this admission inserted the queue
   * row; a pruned event can become new again. It does not imply claim or delivery.
   */
  onDurableAdmission?: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number; isNew: boolean },
  ) => void | Promise<void>;
  onAdmissionFailure?: (raw: TRaw, error: unknown) => void | Promise<void>;
  /** False lets repeated requests fill drain capacity while earlier claims remain active. */
  waitForDeliveryIdleBeforeRepump?: boolean;
  /** Runs each pump under a channel-owned async context such as a detached request root. */
  runPumpTask?: (work: () => Promise<void>) => Promise<void>;
  /** False lets a channel apply its own bounded delivery grace before final disposal. */
  waitForDeliveryIdleOnStop?: boolean;
  /** Tracks deferred reply ownership through stop, abort, or an explicit channel-owned wait. */
  deferredClaims?: "wait-on-stop" | "settle-on-abort" | "manual";
  drain?: ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata>;
  abortSignal?: AbortSignal;
  now?: () => number;
  onError?: (error: unknown) => void;
  onActivityChange?: (active: boolean) => void;
  createStoppedError?: () => Error;
  /** Durable-after-stop preserves append-only admission for handlers selected before unregister. */
  admissionMode?: "until-stopped" | "while-running" | "durable-after-stop";
};
