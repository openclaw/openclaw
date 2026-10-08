import { matchControlUiResourceUrl } from "../../../../src/gateway/control-ui-resource-routes.ts";
import { matchesChannelAvatarSenderSource } from "../../../../src/shared/channel-avatar-source.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SenderIdentity } from "./sender-label.ts";

export type ChannelSenderAvatarSource = Pick<
  GatewaySessionRow,
  "key" | "origin" | "channelAvatarUrl"
>;

/** A DM's native photo is presentation, never a profile or an ownership assertion. */
export function resolveChannelSenderAvatarUrl(
  sender: SenderIdentity,
  session: ChannelSenderAvatarSource | undefined,
  basePath?: string | null,
): string | null {
  const identity = sender.identity;
  const origin = session?.origin;
  const route = session?.channelAvatarUrl;
  if (
    identity?.type !== "observation" ||
    identity.senderKind !== "human" ||
    !identity.pluginId ||
    !identity.accountId ||
    !matchesChannelAvatarSenderSource(origin, identity) ||
    !route
  ) {
    return null;
  }
  const matched = matchControlUiResourceUrl("channelAvatar", route, basePath);
  if (!matched || matched.value !== session.key || matched.hash) {
    return null;
  }
  const url = new URL(route, "http://openclaw.invalid");
  if (!url.searchParams.get("v")) {
    return null;
  }
  url.searchParams.set("provider", identity.pluginId);
  url.searchParams.set("account", identity.accountId);
  url.searchParams.set("sender", identity.id);
  return url.pathname + url.search;
}

export function channelSenderAvatarMemoKey(source: ChannelSenderAvatarSource | null | undefined) {
  return [
    source?.key,
    source?.channelAvatarUrl,
    source?.origin?.provider,
    source?.origin?.accountId,
    source?.origin?.from,
    source?.origin?.nativeDirectUserId,
    source?.origin?.chatType,
  ];
}
