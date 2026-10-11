/** Reads channel plugin output/threading policy for isolated cron delivery. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

type ChannelPluginRuntime = typeof import("../../channels/plugins/index.js");

const channelPluginRuntimeLoader = createLazyImportLoader<ChannelPluginRuntime>(
  () => import("../../channels/plugins/index.js"),
);

/** Resolves channel-specific cron output preferences from loaded channel plugins. */
export async function resolveCronChannelOutputPolicy(
  channel: string | undefined,
  opts?: { deliveryRequested?: boolean },
): Promise<{
  preferFinalAssistantVisibleText: boolean;
}> {
  const channelId = normalizeOptionalLowercaseString(channel);
  if (!channelId) {
    return { preferFinalAssistantVisibleText: opts?.deliveryRequested !== true };
  }
  const { getChannelPlugin } = await channelPluginRuntimeLoader.load();
  return {
    preferFinalAssistantVisibleText:
      getChannelPlugin(channelId)?.outbound?.preferFinalAssistantVisibleText === true,
  };
}

/** Resolves the provider-specific current-thread target for a delivery address. */
export async function resolveCurrentChannelTarget(params: {
  channel?: string;
  to?: string;
  threadId?: string | number | null;
}): Promise<string | undefined> {
  if (!params.to) {
    return undefined;
  }
  const channelId = normalizeOptionalLowercaseString(params.channel);
  if (!channelId) {
    return params.to;
  }
  const { getChannelPlugin } = await channelPluginRuntimeLoader.load();
  return (
    getChannelPlugin(channelId)?.threading?.resolveCurrentChannelId?.({
      to: params.to,
      threadId: params.threadId,
    }) ?? params.to
  );
}

/** Prepares the same channel-native conversation context for CLI and embedded cron runs. */
export async function resolveCronCurrentChannelContext(
  params: Parameters<typeof resolveCurrentChannelTarget>[0],
): Promise<{ currentChannelId?: string; currentThreadTs?: string }> {
  return {
    currentChannelId: await resolveCurrentChannelTarget(params),
    currentThreadTs: normalizeOptionalStringifiedId(params.threadId),
  };
}
