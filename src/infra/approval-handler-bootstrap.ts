import { resolveChannelApprovalCapability } from "../channels/plugins/approvals.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../gateway/protocol/connect-error-details.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createChannelApprovalHandlerFromCapability,
  type ChannelApprovalHandler,
} from "./approval-handler-runtime.js";
import {
  getChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";

type ApprovalBootstrapHandler = ChannelApprovalHandler;
const APPROVAL_HANDLER_BOOTSTRAP_INITIAL_RETRY_MS = 1_000;
const APPROVAL_HANDLER_BOOTSTRAP_MAX_RETRY_MS = 60_000;
const APPROVAL_HANDLER_BOOTSTRAP_PAIRING_REQUIRED_RETRY_MS = 300_000;

type ApprovalBootstrapRetryDecision = {
  delayMs: number;
  reason: "pairing-required" | "transient";
};

function readErrorDetails(error: unknown): unknown {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  return (error as { details?: unknown }).details;
}

function readPairingRequestId(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const requestId = (details as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.trim().length > 0
    ? requestId.trim()
    : undefined;
}

function isPairingRequiredStartupError(error: unknown): boolean {
  const details = readErrorDetails(error);
  if (readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return true;
  }
  return /pairing required/i.test(String(error));
}

function resolveApprovalHandlerRetryDecision(
  error: unknown,
  retryAttempt: number,
): ApprovalBootstrapRetryDecision {
  if (isPairingRequiredStartupError(error)) {
    return {
      delayMs: APPROVAL_HANDLER_BOOTSTRAP_PAIRING_REQUIRED_RETRY_MS,
      reason: "pairing-required",
    };
  }

  const exponentialDelay =
    APPROVAL_HANDLER_BOOTSTRAP_INITIAL_RETRY_MS * 2 ** Math.max(0, retryAttempt);
  return {
    delayMs: Math.min(exponentialDelay, APPROVAL_HANDLER_BOOTSTRAP_MAX_RETRY_MS),
    reason: "transient",
  };
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs % 1_000 === 0) {
    return `${delayMs / 1_000}s`;
  }
  return `${delayMs}ms`;
}

export async function startChannelApprovalHandlerBootstrap(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "approvalCapability">;
  cfg: OpenClawConfig;
  accountId: string;
  channelRuntime?: ChannelRuntimeSurface;
  logger?: ReturnType<typeof createSubsystemLogger>;
}): Promise<() => Promise<void>> {
  const capability = resolveChannelApprovalCapability(params.plugin);
  if (!capability?.nativeRuntime || !params.channelRuntime) {
    return async () => {};
  }

  const channelLabel = params.plugin.meta.label || params.plugin.id;
  const logger = params.logger ?? createSubsystemLogger(`${params.plugin.id}/approval-bootstrap`);
  let activeGeneration = 0;
  let activeHandler: ApprovalBootstrapHandler | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  const invalidateActiveHandler = () => {
    activeGeneration += 1;
  };
  const resetRetryState = () => {
    retryAttempt = 0;
  };
  const clearRetryTimer = () => {
    if (!retryTimer) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
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
    const handler = await createChannelApprovalHandlerFromCapability({
      capability,
      label: `${params.plugin.id}/native-approvals`,
      clientDisplayName: `${channelLabel} Native Approvals (${params.accountId})`,
      channel: params.plugin.id,
      channelLabel,
      cfg: params.cfg,
      accountId: params.accountId,
      context,
    });
    if (!handler) {
      return;
    }
    if (generation !== activeGeneration) {
      await handler.stop().catch(() => {});
      return;
    }
    activeHandler = handler as ApprovalBootstrapHandler;
    try {
      await handler.start();
      resetRetryState();
    } catch (error) {
      if (activeHandler === handler) {
        activeHandler = null;
      }
      await handler.stop().catch(() => {});
      throw error;
    }
  };

  const spawn = (label: string, promise: Promise<void>) => {
    void promise.catch((error) => {
      logger.error(`${label}: ${String(error)}`);
    });
  };
  const logRetryDecision = (error: unknown, decision: ApprovalBootstrapRetryDecision) => {
    const retryLabel = formatRetryDelay(decision.delayMs);
    if (decision.reason === "pairing-required") {
      const requestId = readPairingRequestId(readErrorDetails(error));
      const requestHint = requestId
        ? `Approve pending request ${requestId} with \`openclaw devices approve ${requestId}\`.`
        : "Run `openclaw devices list` and approve the pending request.";
      logger.warn(
        `native approval handler startup requires gateway device pairing for operator.approvals; retrying in ${retryLabel}. ${requestHint}`,
      );
      return;
    }

    logger.warn(`retrying native approval handler startup in ${retryLabel}`);
  };
  const scheduleRetryForContext = (context: unknown, generation: number, error: unknown) => {
    if (generation !== activeGeneration) {
      return;
    }
    const decision = resolveApprovalHandlerRetryDecision(error, retryAttempt);
    retryAttempt += 1;
    clearRetryTimer();
    logRetryDecision(error, decision);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (generation !== activeGeneration) {
        return;
      }
      spawn(
        "failed to retry native approval handler",
        startHandlerForRegisteredContext(context, generation),
      );
    }, decision.delayMs);
    retryTimer.unref?.();
  };
  const startHandlerForRegisteredContext = async (context: unknown, generation: number) => {
    try {
      await startHandlerForContext(context, generation);
    } catch (error) {
      if (generation === activeGeneration) {
        logger.error(`failed to start native approval handler: ${String(error)}`);
        scheduleRetryForContext(context, generation, error);
      }
    }
  };

  const unsubscribe =
    watchChannelRuntimeContexts({
      channelRuntime: params.channelRuntime,
      channelId: params.plugin.id,
      accountId: params.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      onEvent: (event) => {
        if (event.type === "registered") {
          clearRetryTimer();
          resetRetryState();
          invalidateActiveHandler();
          const generation = activeGeneration;
          spawn(
            "failed to start native approval handler",
            startHandlerForRegisteredContext(event.context, generation),
          );
          return;
        }
        clearRetryTimer();
        resetRetryState();
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
    clearRetryTimer();
    resetRetryState();
    invalidateActiveHandler();
    await startHandlerForRegisteredContext(existingContext, activeGeneration);
  }

  return async () => {
    unsubscribe();
    clearRetryTimer();
    resetRetryState();
    invalidateActiveHandler();
    await stopHandler();
  };
}
