import { resolveChannelApprovalCapability } from "../channels/plugins/approvals.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
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

export async function startChannelApprovalHandlerBootstrap(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "approvalCapability">;
  cfg: OpenClawConfig;
  accountId: string;
  channelRuntime?: PluginRuntime["channel"];
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
  const invalidateActiveHandler = () => {
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

  const startHandlerForContext = async (context: unknown) => {
    invalidateActiveHandler();
    const generation = activeGeneration;
    await stopHandler();
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

  const unsubscribe =
    watchChannelRuntimeContexts({
      channelRuntime: params.channelRuntime,
      channelId: params.plugin.id,
      accountId: params.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      onEvent: (event) => {
        if (event.type === "registered") {
          spawn("failed to start native approval handler", startHandlerForContext(event.context));
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
    await startHandlerForContext(existingContext);
  }

  return async () => {
    unsubscribe();
    invalidateActiveHandler();
    await stopHandler();
  };
}
