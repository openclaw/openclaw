import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveChannelPluginRegistration } from "../channels/plugins/registry.js";
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingPreviewToolProgress,
} from "../channels/streaming.js";
import { resolveChannelConfigRecord } from "../config/channel-configured-shared.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { resolveMessageActionOutcome } from "../infra/outbound/message-action-contracts.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import type { TaskProgressMessageTarget } from "./task-progress-message.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export async function prepareTaskControlUiSessionUrl(assertCurrent: () => void) {
  const { config } = await captureRuntimeConfigAsyncReader({ assertCurrent, capture: true })();
  assertCurrent();
  return (params: { sessionKey: string; fallbackAgentId?: string }): string | undefined => {
    assertCurrent();
    return resolveControlUiSessionUrl(config, { ...params, exactKey: true });
  };
}

/** Prepare the current preference snapshot for a yield-authorized harness progress card. */
export async function prepareTaskProgressPreferenceReader(assertCurrent: () => void) {
  const { config } = await captureRuntimeConfigAsyncReader({ assertCurrent, capture: true })();
  assertCurrent();
  return (channel: string | undefined, accountId: string | undefined): boolean => {
    assertCurrent();
    if (!channel || !accountId) {
      return false;
    }
    // The registered channel owns account inheritance; do not recreate its merge policy here.
    const plugin = resolveChannelPluginRegistration(channel, { loadedOnly: true })?.plugin;
    const account = asOptionalRecord(plugin?.config.resolveAccount(config, accountId));
    const root = resolveChannelConfigRecord(config, channel);
    // Top-level owners can return metadata only. Never merge or infer account overrides.
    const entry =
      asOptionalRecord(account?.config) ??
      (account && !("config" in account) && root?.accounts === undefined ? root : undefined);
    const streaming = { streaming: entry?.streaming };
    const mode = resolveChannelPreviewStreamMode(streaming, "off");
    return (
      mode === "progress" && resolveChannelStreamingPreviewToolProgress(streaming, false, mode)
    );
  };
}

export async function editTaskProgressMessage(
  params: TaskProgressMessageTarget & {
    content: string;
    agentId?: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  params.assertCurrent();
  const { config } = await captureRuntimeConfigAsyncReader({
    assertCurrent: params.assertCurrent,
    capture: true,
  })();
  params.assertCurrent();
  const result = await runMessageAction({
    cfg: config,
    action: "edit",
    params: {
      channel: params.channel,
      target: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
      messageId: params.messageId,
      message: params.content,
    },
    agentId: params.agentId,
    requesterAccountId: params.requesterOrigin.accountId,
    // Retained originating conversation under the live progress owner, not a new inbound turn.
    // In particular, the outgoing receipt must never become a trusted currentMessageId.
    toolContext: {
      currentChannelProvider: normalizeMessageChannel(params.requesterOrigin.channel),
      currentMessagingTarget: params.requesterOrigin.to,
      currentThreadTs:
        params.requesterOrigin.threadId === undefined
          ? undefined
          : String(params.requesterOrigin.threadId),
    },
    gatewayOwnedDelivery: true,
    suppressTranscriptMirror: true,
    assertDirectAdapterHandoff: params.assertCurrent,
  });
  const outcome = resolveMessageActionOutcome(result);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
}
