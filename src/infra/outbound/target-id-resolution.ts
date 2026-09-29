// Id-like target resolution gates plugin directory lookups to inputs that are
// specific enough to avoid broad name searches.
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  maybeResolvePluginMessagingTarget,
  type ResolvedPluginMessagingTarget,
} from "./target-normalization.js";

/** Resolves an id-like outbound target through the channel plugin directory. */
export async function maybeResolveIdLikeTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: ChannelDirectoryEntryKind | "channel";
  plugin?: ChannelPlugin;
}): Promise<ResolvedPluginMessagingTarget | undefined> {
  return maybeResolvePluginMessagingTarget({
    ...params,
    requireIdLike: true,
  });
}
