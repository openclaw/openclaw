// Bootstraps approval handlers from channel plugin capabilities.
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
  logger?: ReturnType<typeof createSubsystemLogger>;
}): Promise<() => Promise<void>> {
  const capability = resolveChannelApprovalCapability(params.plugin);
  if (!capability?.nativeRuntime || !params.channelRuntime) {
    return async () => {};
  }

  const channelLabel = params.plugin.meta.label || params.plugin.id;
  const logger = params.logger ?? createSubsystemLogger(`${params.plugin.id}/approval-bootstrap`);
  const retryId = `approval-bootstrap/${params.plugin.id}/${params.accountId}/${randomUUID()}`;
  let activeGeneration = 0;
  let activeHandler: ChannelApprovalHandler | null = null;
  let retryJob: GatewayScheduledJob | undefined;
  const invalidateActiveHandler = () => {
    retryJob?.cancel();
    retryJob = undefined;
    activeGeneration += 1;
  };

  const stopHandler = async () => {
    const handler = activeHandler;
    activeHandler = null;
    if (!handler) {
      return;
    }
    await handler.stop();
  };

  const startHandlerForContext = async (context: unknown, generation: number) => {
    if (generation !== activeGeneration) {
      return;
    }
    await stopHandler();
    if (generation !== activeGeneration) {
      return;
    }
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
    if (generation !== activeGeneration) {
      // Runtime contexts can unregister while the handler factory awaits; stop stale handlers.
      await handler.stop().catch(() => {});
      return;
    }
    activeHandler = handler;
    try {
      await withGatewayNativeApprovalRuntime(params.gatewayRuntime, () => handler.start());
    } catch (error) {
      if (activeHandler === handler) {
        activeHandler = null;
      }
      await handler.stop().catch(() => {});
      throw error;
    }
  };

  const spawn = (label: string, promise: Promise<void>) => {
    void promise.catch((error: unknown) => {
      logger.error(`${label}: ${String(error)}`);
    });
  };
  const scheduleRetryForContext = (context: unknown, generation: number) => {
    if (generation !== activeGeneration) {
      return;
    }
    retryJob = params.scheduler.schedule({
      id: retryId,
      delayMs: APPROVAL_HANDLER_BOOTSTRAP_RETRY_MS,
      run: () => startHandlerForRegisteredContext(context, generation),
    });
  };
  const startHandlerForRegisteredContext = async (context: unknown, generation: number) => {
    try {
      await startHandlerForContext(context, generation);
    } catch (error) {
      if (generation === activeGeneration) {
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
        scheduleRetryForContext(context, generation);
      }
    }
  };

  const startForContext = (context: unknown) => {
    invalidateActiveHandler();
    spawn(
      "failed to start native approval handler",
      startHandlerForRegisteredContext(context, activeGeneration),
    );
  };

  const unsubscribe =
    watchChannelRuntimeContexts({
      channelRuntime: params.channelRuntime,
      channelId: params.plugin.id,
      accountId: params.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      onEvent: (event) => {
        if (event.type === "registered") {
          startForContext(event.context);
          return;
        }
        invalidateActiveHandler();
        spawn("failed to stop native approval handler", stopHandler());
      },
    }) ?? (() => {});

  const existingContext = getChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    channelId: params.plugin.id,
    accountId: params.accountId,
    capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  });
  if (existingContext !== undefined) {
    startForContext(existingContext);
  }

  return async () => {
    unsubscribe();
    invalidateActiveHandler();
    await stopHandler();
  };
}
