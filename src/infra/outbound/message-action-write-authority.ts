import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";
import { enforceMessageActionAllowlist } from "./outbound-policy.js";

/** Admit preparation and execution against the same invocation configuration. */
export function prepareMessageActionWriteAuthority(params: {
  context: ChannelMessageActionContext & { accountId: string };
  plugin: ChannelPlugin;
  hasRegistrationAuthority: boolean;
  assertCurrent: () => void;
}): ChannelMessageActionContext {
  const { context, plugin } = params;
  const { action, channel, accountId } = context;
  if (
    !params.hasRegistrationAuthority ||
    !plugin.actions?.writeAuthorityActions?.includes(action)
  ) {
    throw new Error(
      `Scheduled ${channel}:${action} requires an active bundled or verified official plugin with write authorization support. Update and reload a supported plugin, then retry.`,
    );
  }
  const assertCurrent = () => {
    params.assertCurrent();
    context.assertDirectAdapterHandoff?.();
  };
  assertCurrent();
  // Configuration governs admission; later retries retain that decision while
  // still checking the live job, caller, and selected plugin before every request.
  const cfg = context.cfg;
  enforceMessageActionAllowlist({ cfg, agentId: context.agentId, action });
  validateExplicitMessageAccountSelection({ cfg, channel, accountId, plugin });
  const available = plugin.actions?.describeMessageTool({
    cfg,
    accountId,
    agentId: context.agentId ?? undefined,
    sessionKey: context.sessionKey ?? undefined,
    sessionId: context.sessionId ?? undefined,
    requesterSenderId: context.requesterSenderId ?? undefined,
    senderIsOwner: context.senderIsOwner,
  });
  if (!available?.actions?.includes(action)) {
    throw new Error(`Scheduled ${channel}:${action} is disabled for this account.`);
  }
  return { ...context, accountId, assertDirectAdapterHandoff: assertCurrent };
}

/** Retain an admitted writer's request guard through provider settlement. */
export async function withMessageActionWriteAuthority<T>(params: {
  context: ChannelMessageActionContext;
  run: (context: ChannelMessageActionContext) => Promise<T>;
}): Promise<T> {
  const { context } = params;
  let open = true;
  const assertCurrent = () => {
    if (!open) {
      throw new Error(
        `Scheduled ${context.channel}:${context.action} invocation is no longer active.`,
      );
    }
    context.assertDirectAdapterHandoff?.();
  };
  try {
    assertCurrent();
    return await params.run({ ...context, assertDirectAdapterHandoff: assertCurrent });
  } finally {
    // Submitted requests settle; neither success nor rejection leaves a replayable callback.
    open = false;
  }
}
