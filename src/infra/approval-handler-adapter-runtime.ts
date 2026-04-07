import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type {
  ChannelApprovalNativeAvailabilityAdapter,
  ChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.js";

export const CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native";

type LazyChannelApprovalNativeRuntimeParams = {
  load: () => Promise<ChannelApprovalNativeRuntimeAdapter>;
  isConfigured: ChannelApprovalNativeAvailabilityAdapter["isConfigured"];
  shouldHandle: ChannelApprovalNativeAvailabilityAdapter["shouldHandle"];
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
};

export function createLazyChannelApprovalNativeRuntimeAdapter(
  params: LazyChannelApprovalNativeRuntimeParams,
): ChannelApprovalNativeRuntimeAdapter {
  const loadRuntime = createLazyRuntimeModule(params.load);
  let loadedRuntime: ChannelApprovalNativeRuntimeAdapter | null = null;
  const loadResolvedRuntime = async (): Promise<ChannelApprovalNativeRuntimeAdapter> => {
    const runtime = await loadRuntime();
    loadedRuntime = runtime;
    return runtime;
  };
  const loadRequired = async <TResult>(
    select: (runtime: ChannelApprovalNativeRuntimeAdapter) => TResult,
  ): Promise<TResult> => select(await loadResolvedRuntime());
  const loadOptional = async <TResult>(
    select: (runtime: ChannelApprovalNativeRuntimeAdapter) => TResult | undefined,
  ): Promise<TResult | undefined> => select(await loadResolvedRuntime());

  return {
    ...(params.eventKinds ? { eventKinds: params.eventKinds } : {}),
    ...(params.resolveApprovalKind ? { resolveApprovalKind: params.resolveApprovalKind } : {}),
    availability: {
      isConfigured: params.isConfigured,
      shouldHandle: params.shouldHandle,
    },
    presentation: {
      buildPendingPayload: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildPendingPayload))(runtimeParams),
      buildResolvedResult: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildResolvedResult))(runtimeParams),
      buildExpiredResult: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildExpiredResult))(runtimeParams),
    },
    transport: {
      prepareTarget: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.transport.prepareTarget))(runtimeParams),
      deliverPending: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.transport.deliverPending))(runtimeParams),
      updateEntry: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.transport.updateEntry)
        )?.(runtimeParams),
      deleteEntry: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.transport.deleteEntry)
        )?.(runtimeParams),
    },
    interactions: {
      bindPending: async (runtimeParams) =>
        (await loadOptional((runtime) => runtime.interactions?.bindPending))?.(runtimeParams),
      unbindPending: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.interactions?.unbindPending)
        )?.(runtimeParams),
      clearPendingActions: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.interactions?.clearPendingActions)
        )?.(runtimeParams),
    },
    observe: {
      // Observe hooks are fire-and-forget at call sites. Reuse the already
      // loaded runtime instead of introducing unawaited lazy-load promises.
      onDeliveryError: (runtimeParams) => loadedRuntime?.observe?.onDeliveryError?.(runtimeParams),
      onDuplicateSkipped: (runtimeParams) =>
        loadedRuntime?.observe?.onDuplicateSkipped?.(runtimeParams),
      onDelivered: (runtimeParams) => loadedRuntime?.observe?.onDelivered?.(runtimeParams),
    },
  };
}
