import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { markdownSessionPublicOrigin } from "../../components/markdown-session-links.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";

type ResourceProps = Pick<
  ChatProps,
  | "mediaPolicyEpoch"
  | "connectionEpoch"
  | "embedSandboxMode"
  | "allowExternalEmbedUrls"
  | "fetchLinkFavicon"
  | "assistantAttachmentAuthToken"
  | "resolveArtifactDownload"
  | "basePath"
  | "sessionPublicOrigin"
  | "resourceBasePath"
>;

export function chatPaneResourceProps(
  state: ChatPageHost,
  context: ApplicationContext,
): ResourceProps {
  return {
    mediaPolicyEpoch: state.mediaPolicyEpoch,
    connectionEpoch: state.connectionEpoch,
    embedSandboxMode: state.embedSandboxMode,
    allowExternalEmbedUrls: state.allowExternalEmbedUrls,
    fetchLinkFavicon: resolveChatLinkFaviconFetcher(state),
    assistantAttachmentAuthToken: resolveControlUiAuthToken(state),
    resolveArtifactDownload: (params, signal) =>
      resolveArtifactDownloadSource(state, params, signal),
    basePath: state.basePath,
    sessionPublicOrigin: markdownSessionPublicOrigin(context),
    resourceBasePath: state.resourceBasePath,
  };
}
