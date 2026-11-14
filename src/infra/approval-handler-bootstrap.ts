import { randomUUID } from "node:crypto";
import { resolveChannelApprovalCapability } from "../channels/plugins/approvals.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createChannelApprovalHandlerFromCapability,
  type ChannelApprovalHandler,
} from "./approval-handler-runtime.js";
import {
  getChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";
import { isExecApprovalChannelRuntimeTerminalStartError } from "./exec-approval-channel-runtime.js";
import type { GatewayScheduledJob, GatewayScheduler } from "./gateway-scheduler.js";

const APPROVAL_HANDLER_BOOTSTRAP_RETRY_MS = 1_000;

function isRetryableApprovalBootstrapStartError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("gateway readiness unavailable before approval client start") ||
    message.includes("gateway approval client start aborted before readiness") ||
    message.includes("gateway readiness unavailable before exec approval runtime start") ||
    message.includes("gateway approval runtime start aborted before readiness") ||
    message.includes("gateway event loop readiness timeout") ||
    message.includes("gateway starting") ||
    message.includes("code=1013") ||
    message.includes("close code 1013")
  );
}

function formatRetryableApprovalBootstrapStartError(error: unknown): string {
  const message = String(error);
  if (message.includes("gateway event loop readiness timeout")) {
    return "gateway readiness unavailable before approval handler start";
  }
  return message;
}

/** Starts the native approval handler for a channel runtime context and returns its cleanup hook. */
export async function startChannelApprovalHandlerBootstrap(params: {
  scheduler: GatewayScheduler;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "approvalCapability">;
  cfg: OpenClawConfig;
  accountId: string;
  channelRuntime?: ChannelRuntimeSurface;
  gatewayRuntime?: GatewayNativeApprovalRuntime;
  abortSignal?: AbortSignal;
  logger?: ReturnType<typeof createSubsystemLogger>;
}): Promise<() => Promise<void>> {
  const capability = resolveChannelApprovalCapability(params.plugin);
  if (
    !(capability?.nativeRuntimeAsync ?? capability?.nativeRuntime) ||
    !params.channelRuntime ||
    params.abortSignal?.aborted
  ) {
    return async () => {};
  }

  const channelLabel = params.plugin.meta.label || params.plugin.id;
  const logger = params.logger ?? createSubsystemLogger(`${params.plugin.id}/approval-bootstrap`);
  const retryId = `approval-bootstrap/${params.plugin.id}/${params.accountId}/${randomUUID()}`;
  let stopped = false;
  const contextKey = {
    channelRuntime: params.channelRuntime,
    channelId: params.plugin.id,
    accountId: params.accountId,
    capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  };
  const currentContext = () => (stopped ? undefined : getChannelRuntimeContext(contextKey));
  let activeHandler: ChannelApprovalHandler | null = null;
  let retryJob: GatewayScheduledJob | undefined;
  const cancelRetry = () => {
    retryJob?.cancel();
    retryJob = undefined;
  };

  const stopHandler = async () => {
    const handler = activeHandler;
    activeHandler = null;
    if (handler) {
      await handler.stop();
    }
  };

  const startHandlerForContext = async (context: unknown) => {
    await stopHandler();
    const handler = await withGatewayNativeApprovalRuntime(params.gatewayRuntime, () =>
      createChannelApprovalHandlerFromCapability({
        capability,
        label: `${params.plugin.id}/native-approvals`,
        clientDisplayName: `${channelLabel} Native Approvals (${params.accountId})`,
        channel: params.plugin.id,
        channelLabel,
        cfg: params.cfg,
        accountId: params.accountId,
        context,
      }),
    );
    if (!handler) {
      return;
    }
    // Starting subscribes to external approval delivery; require the live context here.
    if (context !== currentContext()) {
      await handler.stop();
      return;
    }
    activeHandler = handler;
    try {
      await withGatewayNativeApprovalRuntime(params.gatewayRuntime, () => handler.start());
    } catch (error) {
      if (activeHandler === handler) {
        activeHandler = null;
      }
      await handler.stop().catch((stopError: unknown) => {
        logger.error(`failed to clean up native approval handler: ${String(stopError)}`);
      });
      throw error;
    }
  };

  const spawn = (label: string, promise: Promise<void>) => {
    void promise.catch((error: unknown) => {
      logger.error(`${label}: ${String(error)}`);
    });
  };
  const startRegisteredHandler = async (): Promise<void> => {
    const context = currentContext();
    if (context === undefined) {
      return;
    }
    try {
      await startHandlerForContext(context);
    } catch (error) {
      if (isExecApprovalChannelRuntimeTerminalStartError(error)) {
        logger.error(`native approval handler disabled: ${String(error)}`);
        return;
      }
      if (isRetryableApprovalBootstrapStartError(error)) {
        logger.warn(
          `native approval handler deferred until gateway readiness recovers: ${formatRetryableApprovalBootstrapStartError(error)}`,
        );
      } else {
        logger.error(`failed to start native approval handler: ${String(error)}`);
      }
      retryJob = params.scheduler.schedule({
        id: retryId,
        delayMs: APPROVAL_HANDLER_BOOTSTRAP_RETRY_MS,
        run: startRegisteredHandler,
      });
    }
  };

  const unsubscribe =
    watchChannelRuntimeContexts({
      ...contextKey,
      onEvent: (event) => {
        cancelRetry();
        if (event.type === "registered") {
          spawn("failed to start native approval handler", startRegisteredHandler());
          return;
        }
        spawn("failed to stop native approval handler", stopHandler());
      },
    }) ?? (() => {});

  spawn("failed to start native approval handler", startRegisteredHandler());

  const cleanup = async () => {
    stopped = true;
    params.abortSignal?.removeEventListener("abort", onAbort);
    unsubscribe();
    cancelRetry();
    await stopHandler();
  };
  // A timed-out provider can outlive its account. Revoke its watcher on abort,
  // before a replacement context can rearm the abandoned approval handler.
  const onAbort = () => spawn("failed to stop aborted native approval handler", cleanup());
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (params.abortSignal?.aborted) {
    await cleanup();
  }
  return cleanup;
}
