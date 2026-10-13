import { resolveApprovalRequestSessionDeliveryAsync } from "../infra/approval-request-account-binding.js";
import {
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestOriginTargetAsync,
  type ExecApprovalSessionTarget,
} from "../infra/exec-approval-session-target.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type {
  ApprovalRequest,
  ApprovalResolverParams,
  NativeOriginResolverParams,
  CustomOriginResolverParams,
  NativeApprovalTarget,
} from "./approval-native-helpers.types.js";
import { channelRouteTargetsMatchExact } from "./channel-route.js";
import type { OpenClawConfig } from "./config-contracts.js";

/** Compare channel-native approval targets with the same normalization used by outbound routes. */
export function nativeApprovalTargetsMatch(params: {
  /** Channel id used for route target normalization. */
  channel?: string | null;
  /** Left native target to compare. */
  left: NativeApprovalTarget;
  /** Right native target to compare. */
  right: NativeApprovalTarget;
}): boolean {
  return channelRouteTargetsMatchExact({
    left: {
      channel: params.channel,
      to: params.left.to,
      accountId: params.left.accountId,
      threadId: params.left.threadId,
    },
    right: {
      channel: params.channel,
      to: params.right.to,
      accountId: params.right.accountId,
      threadId: params.right.threadId,
    },
  });
}

function isNativeApprovalTarget(value: unknown): value is NativeApprovalTarget {
  return (
    value !== null && typeof value === "object" && "to" in value && typeof value.to === "string"
  );
}

function nativeApprovalTargetMatcher(channel: string): (left: unknown, right: unknown) => boolean {
  return (left, right) =>
    isNativeApprovalTarget(left) &&
    isNativeApprovalTarget(right) &&
    nativeApprovalTargetsMatch({ channel, left, right });
}

function createOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null {
  return (input: ApprovalResolverParams): TTarget | null => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return null;
    }
    return resolveApprovalRequestOriginTarget(originTargetOptions(params, input));
  };
}

function originTargetOptions<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
  input: ApprovalResolverParams,
) {
  const normalizeTarget = (target: TTarget | null): TTarget | null => {
    if (!target) {
      return null;
    }
    return params.normalizeTarget
      ? (params.normalizeTarget(target, input.request) ?? null)
      : target;
  };
  const normalizeTargetForMatch = (target: TTarget): TTarget | null =>
    params.normalizeTargetForMatch?.(target, input.request) ?? target;
  return {
    cfg: input.cfg,
    request: input.request,
    channel: params.channel,
    accountId: input.accountId,
    resolveTurnSourceTarget: (request: ApprovalRequest) =>
      normalizeTarget(params.resolveTurnSourceTarget(request)),
    resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget) =>
      normalizeTarget(params.resolveSessionTarget(sessionTarget, input.request)),
    targetsMatch: (left: TTarget, right: TTarget) => {
      // Some transports need native delivery ids unchanged while matching on
      // normalized aliases, so matcher normalization is separate from output normalization.
      const normalizedLeft = normalizeTargetForMatch(left);
      const normalizedRight = normalizeTargetForMatch(right);
      return Boolean(
        normalizedLeft && normalizedRight && params.targetsMatch(normalizedLeft, normalizedRight),
      );
    },
    resolveFallbackTarget: params.resolveFallbackTarget
      ? (request: ApprovalRequest) =>
          normalizeTarget(params.resolveFallbackTarget?.(request) ?? null)
      : undefined,
  };
}

function hasCustomTargetsMatch<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): params is CustomOriginResolverParams<TTarget> {
  return typeof params.targetsMatch === "function";
}

/** @deprecated Use createChannelNativeOriginTargetResolverAsync for worker-owned session reads. */
export function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(
  params: NativeOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
/** @deprecated Use createChannelNativeOriginTargetResolverAsync for worker-owned session reads. */
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => NativeApprovalTarget | TTarget | null {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: "createChannelNativeOriginTargetResolver",
    replacement: "createChannelNativeOriginTargetResolverAsync",
  });
  if (hasCustomTargetsMatch(params)) {
    return createOriginTargetResolver(params);
  }
  return createOriginTargetResolver({
    ...params,
    targetsMatch: nativeApprovalTargetMatcher(params.channel),
  });
}

/** Create a resolver for configured approver DM targets. */
export function createChannelApproverDmTargetResolver<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  /** Optional gate; returning false skips approver DM delivery for the request. */
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  /** Resolves approver records from config and optional account scope. */
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  /** Maps one approver record to a native DM target; nullish results are skipped. */
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}) {
  return (input: ApprovalResolverParams): TTarget[] => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return [];
    }
    const targets: TTarget[] = [];
    for (const approver of params.resolveApprovers({
      cfg: input.cfg,
      accountId: input.accountId,
    })) {
      const target = params.mapApprover(approver, input);
      if (target) {
        targets.push(target);
      }
    }
    return targets;
  };
}

type AsyncOriginResolverParams<TTarget> = Omit<
  CustomOriginResolverParams<TTarget>,
  "shouldHandleRequest"
> & {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean | Promise<boolean>;
};

/** Resolve native origin targets through worker-owned session reads. */
export function createChannelNativeOriginTargetResolverAsync<TTarget extends NativeApprovalTarget>(
  params: Omit<NativeOriginResolverParams<TTarget>, "shouldHandleRequest"> & {
    shouldHandleRequest?: (params: ApprovalResolverParams) => boolean | Promise<boolean>;
  },
): (input: ApprovalResolverParams) => Promise<TTarget | null>;
export function createChannelNativeOriginTargetResolverAsync<TTarget>(
  params: AsyncOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => Promise<TTarget | null>;
export function createChannelNativeOriginTargetResolverAsync<TTarget>(
  params:
    | (Omit<NativeOriginResolverParams<NativeApprovalTarget>, "shouldHandleRequest"> & {
        shouldHandleRequest?: (params: ApprovalResolverParams) => boolean | Promise<boolean>;
      })
    | AsyncOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => Promise<NativeApprovalTarget | TTarget | null> {
  if (hasCustomAsyncTargetsMatch(params)) {
    return createOriginTargetResolverAsync({ ...params, targetsMatch: params.targetsMatch });
  }
  return createOriginTargetResolverAsync({
    ...params,
    targetsMatch: nativeApprovalTargetMatcher(params.channel),
  });
}

function hasCustomAsyncTargetsMatch<TTarget>(
  params:
    | (Omit<NativeOriginResolverParams<NativeApprovalTarget>, "shouldHandleRequest"> & {
        shouldHandleRequest?: (params: ApprovalResolverParams) => boolean | Promise<boolean>;
      })
    | AsyncOriginResolverParams<TTarget>,
): params is AsyncOriginResolverParams<TTarget> {
  return typeof params.targetsMatch === "function";
}

function createOriginTargetResolverAsync<TTarget>(params: AsyncOriginResolverParams<TTarget>) {
  return async (input: ApprovalResolverParams): Promise<TTarget | null> => {
    const sessionDelivery =
      input.sessionDelivery === undefined
        ? await resolveApprovalRequestSessionDeliveryAsync(input)
        : input.sessionDelivery;
    const preparedInput = { ...input, sessionDelivery };
    if (params.shouldHandleRequest && !(await params.shouldHandleRequest(preparedInput))) {
      return null;
    }
    return resolveApprovalRequestOriginTargetAsync({
      ...originTargetOptions({ ...params, shouldHandleRequest: undefined }, preparedInput),
      sessionDelivery,
    });
  };
}

/** Resolve configured approver DM targets after asynchronous account eligibility. */
export function createChannelApproverDmTargetResolverAsync<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean | Promise<boolean>;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}) {
  const resolveTargets = createChannelApproverDmTargetResolver({
    ...params,
    shouldHandleRequest: undefined,
  });
  return async (input: ApprovalResolverParams): Promise<TTarget[]> =>
    !params.shouldHandleRequest || (await params.shouldHandleRequest(input))
      ? resolveTargets(input)
      : [];
}
