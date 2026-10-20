import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import type { MarkdownGitHubContext } from "../../../components/markdown-render-options.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { createSessionWorkspaceProps } from "./chat-session-workspace.ts";
import type {
  AttachmentSidebarRuntime,
  FileSidebarNavigation,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";

type SessionWorkspaceView = ReturnType<typeof createSessionWorkspaceProps>;
export type SessionWorkspaceProps = Omit<
  SessionWorkspaceView,
  "connectionEpoch" | "onDownloadFile" | "onOpenDiff"
> &
  Partial<Pick<SessionWorkspaceView, "connectionEpoch" | "onDownloadFile" | "onOpenDiff">>;

/** Navigation facts/operations supplied by the workspace/tab owner, never a reader-local stack. */
export type FileReaderWorkspace = {
  path: string;
  rootLabel: string;
  sourceLabel?: string;
  catalog: SessionWorkspaceProps;
  /** The tab owner switches the content mode of this same document tab. */
  showingFolder: boolean;
  onBrowsePath: (path: string) => void;
};

export type ChatDetailPanelProps = {
  content: ChatDetailPanelContent | null;
  fileNavigation: FileSidebarNavigation | null;
  execNode: string | null;
  attachmentRuntime: AttachmentSidebarRuntime;
  basePath: string;
  canvasPluginSurfaceUrl: string | null;
  embedSandboxMode: EmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  githubContext: MarkdownGitHubContext;
  embedded: boolean;
  onOpenWorkspaceFile: ((target: MarkdownFileLinkTarget) => void) | null;
  onOpenSessionLink: ((target: SessionLinkTarget) => void) | null;
  onRevealInWorkspace: ((path: string) => void) | null;
  onOpenImage: ((item: ImageLightboxItem) => void) | null;
};
