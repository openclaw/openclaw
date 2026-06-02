import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type {
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

export type { ChannelApprovalKind } from "./approval-types.js";

/** Approval request payload accepted by shared exec and plugin approval handlers. */
export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
/** Approval resolution payload emitted by shared exec and plugin approval handlers. */
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

/** Shared context passed to channel approval capability hooks. */
export type ChannelApprovalCapabilityHandlerContext = {
  /** Runtime config snapshot used for channel/account availability decisions. */
  cfg: OpenClawConfig;
  /** Optional channel account/profile id that owns this approval client. */
  accountId?: string | null;
  /** Gateway URL for runtimes that need to build callback or diagnostic context. */
  gatewayUrl?: string;
  /** Channel-specific context supplied by the caller. */
  context?: unknown;
};

/** Final action a native approval runtime should apply to a delivered pending entry. */
export type ChannelApprovalNativeFinalAction<TPayload> =
  /** Update the delivered entry with a resolved/expired payload. */
  | { kind: "update"; payload: TPayload }
  /** Delete the delivered entry after resolution or expiry. */
  | { kind: "delete" }
  /** Keep the entry but remove interactive approval actions. */
  | { kind: "clear-actions" }
  /** Leave the delivered entry untouched. */
  | { kind: "leave" };

/** Availability gates for a channel-native approval runtime. */
export type ChannelApprovalNativeAvailabilityAdapter = {
  /** Returns whether the native approval client is configured enough to start. */
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean;
  /** Returns whether this runtime should own a specific approval request. */
  shouldHandle: (
    params: ChannelApprovalCapabilityHandlerContext & { request: ApprovalRequest },
  ) => boolean;
};

/** Builds channel-specific pending/final payloads from approval view models. */
export type ChannelApprovalNativePresentationAdapter<
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = {
  buildPendingPayload: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      nowMs: number;
      view: PendingApprovalView;
    },
  ) => TPendingPayload | Promise<TPendingPayload>;
  buildResolvedResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      resolved: ApprovalResolved;
      view: ResolvedApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  buildExpiredResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      view: ExpiredApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
};

type ChannelApprovalNativeTransportAdapterForView<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  prepareTarget: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverPending: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: TPreparedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => TPendingEntry | null | Promise<TPendingEntry | null>;
  updateEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      payload: TFinalPayload;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
  deleteEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
};

/** Transport hooks that prepare channel targets and mutate delivered pending entries. */
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
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => TBinding | null | Promise<TBinding | null>;
  unbindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      binding: TBinding;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
    },
  ) => Promise<void> | void;
  clearPendingActions?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
  cancelDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
    },
  ) => Promise<void> | void;
};

/** Optional hooks for channel-specific interactive controls attached to pending approvals. */
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
    params: ChannelApprovalCapabilityHandlerContext & {
      error: unknown;
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDuplicateSkipped?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
      entry: TPendingEntry;
    },
  ) => void;
};

/** Optional telemetry hooks for native approval delivery outcomes. */
export type ChannelApprovalNativeObserveAdapter<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
> = ChannelApprovalNativeObserveAdapterForView<TPreparedTarget, TPendingPayload, TPendingEntry>;

/** Complete channel-native approval runtime consumed by the shared approval handler. */
export type ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> = {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
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

/** Strongly typed runtime spec used before narrowing view types to the shared adapter shape. */
export type ChannelApprovalNativeRuntimeSpec<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> = {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
  presentation: {
    buildPendingPayload: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
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
