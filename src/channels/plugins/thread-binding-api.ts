import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadOptionalBundledChannelPublicArtifact } from "./optional-public-artifact.js";
import type { ChannelMessagingAdapter } from "./types.core.js";

type ThreadBindingPlacement = "current" | "child";

type ThreadBindingApi = Pick<ChannelMessagingAdapter, "resolveInboundConversation"> & {
  defaultTopLevelPlacement?: unknown;
};

function loadBundledChannelThreadBindingApi(channelId: string): ThreadBindingApi | undefined {
  return loadOptionalBundledChannelPublicArtifact({
    channelId,
    artifactBasename: "thread-binding-api.js",
  });
}

function normalizeThreadBindingPlacement(value: unknown): ThreadBindingPlacement | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return normalized === "current" || normalized === "child" ? normalized : undefined;
}

/**
 * Resolves the default top-level thread-binding placement for a bundled channel.
 */
export function resolveBundledChannelThreadBindingDefaultPlacement(
  channelId: string,
): ThreadBindingPlacement | undefined {
  return normalizeThreadBindingPlacement(
    loadBundledChannelThreadBindingApi(channelId)?.defaultTopLevelPlacement,
  );
}

/**
 * Resolves inbound conversation refs from a bundled channel thread-binding artifact.
 */
export function resolveBundledChannelThreadBindingInboundConversation(
  params: Parameters<NonNullable<ThreadBindingApi["resolveInboundConversation"]>>[0] & {
    channelId: string;
  },
): ReturnType<NonNullable<ThreadBindingApi["resolveInboundConversation"]>> | undefined {
  const api = loadBundledChannelThreadBindingApi(params.channelId);
  if (typeof api?.resolveInboundConversation !== "function") {
    return undefined;
  }
  return api.resolveInboundConversation({
    from: params.from,
    to: params.to,
    conversationId: params.conversationId,
    threadId: params.threadId,
    threadParentId: params.threadParentId,
    isGroup: params.isGroup,
  });
}
