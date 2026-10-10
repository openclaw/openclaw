import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";

export function chatPaneMediaProps(state: ChatPageHost) {
  return {
    mediaPolicyEpoch: state.mediaPolicyEpoch,
    connectionEpoch: state.connectionEpoch,
    embedSandboxMode: state.embedSandboxMode,
    allowExternalEmbedUrls: state.allowExternalEmbedUrls,
    remoteImageOrigins: state.remoteImageOrigins,
    fetchLinkFavicon: resolveChatLinkFaviconFetcher(state),
    assistantAttachmentAuthToken: resolveControlUiAuthToken(state),
    resolveArtifactDownload: (params, signal) =>
      resolveArtifactDownloadSource(state, params, signal),
  } satisfies Partial<ChatProps>;
}
