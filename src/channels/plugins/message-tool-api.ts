import { loadOptionalBundledChannelPublicArtifact } from "./optional-public-artifact.js";
import type { ChannelMessageActionAdapter } from "./types.public.js";

/**
 * Narrow adapter surface used for message-tool schema discovery.
 */
export type ChannelMessageToolDiscoveryAdapter = Pick<
  ChannelMessageActionAdapter,
  "describeMessageTool"
>;

/**
 * Resolves a bundled channel's message-tool discovery adapter without loading the full plugin.
 */
export function resolveBundledChannelMessageToolDiscoveryAdapter(
  channelId: string,
): ChannelMessageToolDiscoveryAdapter | undefined {
  const api: Partial<ChannelMessageToolDiscoveryAdapter> | undefined =
    loadOptionalBundledChannelPublicArtifact({
      channelId,
      artifactBasename: "message-tool-api.js",
    });
  const describeMessageTool = api?.describeMessageTool;
  if (typeof describeMessageTool !== "function") {
    return undefined;
  }
  return { describeMessageTool };
}
