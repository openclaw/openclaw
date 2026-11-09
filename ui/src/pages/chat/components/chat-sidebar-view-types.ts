import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/canvas-embed-policy.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { createSessionWorkspaceProps } from "./chat-session-workspace.ts";
import type {
  MobileFileBack,
  ImageSidebarContent,
  AttachmentSidebarRuntime,
  AttachmentSidebarContent,
  FileSidebarNavigation,
  FileSidebarContent,
  ChatDetailPanelContent,
  FileReaderInteraction,
  FileReaderDraftState,
  WorkspaceFileLinkTarget,
} from "./chat-sidebar-content-types.ts";

type SessionWorkspaceView = ReturnType<typeof createSessionWorkspaceProps>;
type SessionWorkspaceOptionalKey =
  | "readState"
  | "readResult"
  | "transcriptAttachments"
  | "presentation"
  | "folderView"
  | "navigation"
  | "mobileNavigation"
  | "onToggleMobileGroup"
  | "onMobileScroll"
  | "connected"
  | "directories"
  | "onToggleDirectory"
  | "onSearchOpenChange"
  | "onTreeVisibleChange"
  | "onSessionExpandedChange"
  | "onNavigationScroll"
  | "connectionEpoch"
  | "onDownloadFile"
  | "onFindWorkspaceFile"
  | "onOpenDiff";
export type SessionWorkspaceProps = Omit<SessionWorkspaceView, SessionWorkspaceOptionalKey> &
  Partial<Pick<SessionWorkspaceView, SessionWorkspaceOptionalKey>>;

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
  attachmentChat?: import("./chat-composer-types.ts").ChatComposerProps;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  panelPresentation?: "desktop" | "mobile";
  panelActive?: boolean;
  /** Supplied by the native shell; a narrow desktop panel is still desktop. */
  filePresentation?: "desktop" | "mobile";
  fileBack?: MobileFileBack | null;
  filePresented?: boolean;
  fileWorkspace?: FileReaderWorkspace | null;
  onFileInteraction?:
    | ((
        file: FileSidebarContent | ImageSidebarContent | AttachmentSidebarContent,
        interaction: FileReaderInteraction,
      ) => void)
    | null;
  onFileDraftChange?: ((draft: FileReaderDraftState | null) => void) | null;
  content: ChatDetailPanelContent | null;
  fileNavigation: FileSidebarNavigation | null;
  execNode: string | null;
  attachmentRuntime: AttachmentSidebarRuntime;
  basePath: string;
  canvasPluginSurfaceUrl: string | null;
  embedSandboxMode: EmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  embedded: boolean;
  onOpenWorkspaceFile: ((target: WorkspaceFileLinkTarget) => void) | null;
  onBrowseFiles?: (() => void) | null;
  onOpenSessionLink: ((target: SessionLinkTarget) => void) | null;
  onRevealInWorkspace: ((path: string) => void) | null;
  onOpenImage: ((item: ImageLightboxItem) => void) | null;
};

export type ChatDetailPanel = SolidBridgeElement<ChatDetailPanelProps>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-detail-panel": ChatDetailPanel;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-detail-panel": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-detail-panel"]
      > & {
        [Key in keyof ChatDetailPanelProps as `prop:${Key}`]?: ChatDetailPanelProps[Key];
      };
    }
  }
}
