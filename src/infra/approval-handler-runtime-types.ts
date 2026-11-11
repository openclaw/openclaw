import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime-types.js";
import type {
  ApprovalRequestInput,
  ApprovalResolved,
  ChannelApprovalKind,
} from "./approval-types.js";
import type {
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
export type { ApprovalResolved, ChannelApprovalKind } from "./approval-types.js";

/** Backward-compatible approval request accepted by public plugin callbacks. */
export type ApprovalRequest = ApprovalRequestInput;

export type ChannelApprovalCapabilityHandlerContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
};

type ApprovalRequestContext = ChannelApprovalCapabilityHandlerContext & {
  request: ApprovalRequest;
  /** Payload-derived owner; channel adapters must not infer ownership from the id. */
  approvalKind: ChannelApprovalKind;
};

type PendingApprovalContext<
  TView extends PendingApprovalView,
  TPayload,
> = ApprovalRequestContext & { view: TView; pendingPayload: TPayload };

type FinalApprovalEntryContext<TEntry> = ChannelApprovalCapabilityHandlerContext & {
  entry: TEntry;
  phase: "resolved" | "expired";
};

export type ChannelApprovalNativeFinalAction<TPayload> =
  | { kind: "update"; payload: TPayload }
  | { kind: "delete" }
  | { kind: "clear-actions" }
  | { kind: "leave" };

/** Synchronous eligibility for adapters whose availability is already in memory. */
export type ChannelApprovalNativeAvailabilityAdapter = {
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean;
  shouldHandle: (params: ApprovalRequestContext) => boolean;
};

/** Eligibility may prepare account state through its owning worker. */
export type ChannelApprovalNativeAvailabilityAdapterAsync = {
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean | Promise<boolean>;
  shouldHandle: (params: ApprovalRequestContext) => boolean | Promise<boolean>;
};

type ChannelApprovalNativePresentationAdapterForView<
  TPendingPayload = unknown,
  TFinalPayload = unknown,
  TPendingEntry = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> = {
  buildPendingPayload: (
    params: ApprovalRequestContext & {
      nowMs: number;
      view: TPendingView;
    },
  ) => TPendingPayload | Promise<TPendingPayload>;
  buildResolvedResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      resolved: ApprovalResolved;
      view: TResolvedView;
      entry: TPendingEntry;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  buildExpiredResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      view: TExpiredView;
      entry: TPendingEntry;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
};

export type ChannelApprovalNativePresentationAdapter<
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = ChannelApprovalNativePresentationAdapterForView<TPendingPayload, TFinalPayload>;

type ChannelApprovalNativeTransportAdapterForView<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  prepareTarget: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
    },
  ) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverPending: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: TPreparedTarget;
    },
  ) => TPendingEntry | null | Promise<TPendingEntry | null>;
  updateEntry?: (
    params: ApprovalRequestContext &
      FinalApprovalEntryContext<TPendingEntry> & {
        payload: TFinalPayload;
      },
  ) => Promise<void>;
  deleteEntry?: (params: FinalApprovalEntryContext<TPendingEntry>) => Promise<void>;
};

export type ChannelApprovalNativeTransportAdapter<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = ChannelApprovalNativeTransportAdapterForView<
  TPreparedTarget,
  TPendingEntry,
  TPendingPayload,
  TFinalPayload
>;

type ChannelApprovalNativeInteractionAdapterForView<
  TPendingEntry = unknown,
  TBinding = unknown,
  TPendingPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  bindPending?: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      entry: TPendingEntry;
    },
  ) => TBinding | null | Promise<TBinding | null>;
  unbindPending?: (
    params: ApprovalRequestContext & {
      entry: TPendingEntry;
      binding: TBinding;
    },
  ) => Promise<void> | void;
  clearPendingActions?: (params: FinalApprovalEntryContext<TPendingEntry>) => Promise<void>;
  cancelDelivered?: (
    params: ApprovalRequestContext & {
      entry: TPendingEntry;
    },
  ) => Promise<void> | void;
};

export type ChannelApprovalNativeInteractionAdapter<
  TPendingEntry = unknown,
  TBinding = unknown,
> = ChannelApprovalNativeInteractionAdapterForView<TPendingEntry, TBinding>;

type ChannelApprovalNativeObserveAdapterForView<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  onDeliveryError?: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      error: unknown;
      plannedTarget: ChannelApprovalNativePlannedTarget;
    },
  ) => void;
  onDuplicateSkipped?: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    },
  ) => void;
  onDelivered?: (
    params: PendingApprovalContext<TPendingView, TPendingPayload> & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      entry: TPendingEntry;
    },
  ) => void;
  /** Runs after every terminal entry for one approval has been finalized. */
  onFinalized?: (
    params: ApprovalRequestContext & {
      phase: "resolved" | "expired";
    },
  ) => void;
};

export type ChannelApprovalNativeObserveAdapter<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
> = ChannelApprovalNativeObserveAdapterForView<TPreparedTarget, TPendingPayload, TPendingEntry>;

type ChannelApprovalNativeRuntimeOptions = {
  eventKinds?: readonly ChannelApprovalKind[];
  /**
   * Trusted legacy ownership override retained for compatibility.
   * @deprecated Omit this so core derives approval ownership from the request payload.
   */
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
};

/**
 * Runtime adapter consumed by core after a plugin's strongly typed spec has been erased.
 */
export type ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> = ChannelApprovalNativeRuntimeOptions & {
  presentation: ChannelApprovalNativePresentationAdapter<TPendingPayload, TFinalPayload>;
  transport: ChannelApprovalNativeTransportAdapter<
    TPreparedTarget,
    TPendingEntry,
    TPendingPayload,
    TFinalPayload
  >;
  interactions?: ChannelApprovalNativeInteractionAdapter<TPendingEntry, TBinding>;
  observe?: ChannelApprovalNativeObserveAdapter;
};

/**
 * Strongly typed plugin spec used to build a channel-native approval runtime adapter.
 */
export type ChannelApprovalNativeRuntimeSpec<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> = ChannelApprovalNativeRuntimeOptions & {
  presentation: ChannelApprovalNativePresentationAdapterForView<
    TPendingPayload,
    TFinalPayload,
    TPendingEntry,
    TPendingView,
    TResolvedView,
    TExpiredView
  >;
  transport: ChannelApprovalNativeTransportAdapterForView<
    TPreparedTarget,
    TPendingEntry,
    TPendingPayload,
    TFinalPayload,
    TPendingView
  >;
  interactions?: ChannelApprovalNativeInteractionAdapterForView<
    TPendingEntry,
    TBinding,
    TPendingPayload,
    TPendingView
  >;
  observe?: ChannelApprovalNativeObserveAdapterForView<
    TPreparedTarget,
    TPendingPayload,
    TPendingEntry,
    TPendingView
  >;
};

export type ChannelApprovalNativeRuntimeAdapterAsync<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> = Omit<
  ChannelApprovalNativeRuntimeAdapter<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload
  >,
  "availability"
> & { availability: ChannelApprovalNativeAvailabilityAdapterAsync };

export type ChannelApprovalNativeRuntimeSpecAsync<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> = Omit<
  ChannelApprovalNativeRuntimeSpec<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload,
    TPendingView,
    TResolvedView,
    TExpiredView
  >,
  "availability"
> & { availability: ChannelApprovalNativeAvailabilityAdapterAsync };
