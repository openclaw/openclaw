import type { TemplateResult } from "lit";
import type { ChatMessageGetResult } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import type {
  SessionDiffFileTextLoader,
  SessionDiffLoader,
  SessionDiffOwner,
} from "./session-diff-panel.ts";

type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  maxChars?: number;
};

export type SidebarFullMessageLoader = (
  request: SidebarFullMessageRequest,
) => Promise<Partial<ChatMessageGetResult> | null | undefined>;

type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
};

type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  /** Per-preview sandbox ceiling; keeps widget iframes below the global embed mode. */
  sandbox?: "strict" | "scripts";
  rawText?: string | null;
};

type ImageSidebarContent = {
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
};

type AttachmentSidebarSource = {
  src: string;
  playback?: ChatMediaPlaybackMode;
  authToken?: string | null;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

export type AttachmentSidebarState =
  | { status: "pending" }
  | ({ status: "ready" } & AttachmentSidebarSource)
  | { status: "unavailable"; onRetry?: () => void }
  | { status: "error"; reason: string; onRetry?: () => void };

export type AttachmentSidebarRuntime = {
  sessionKey?: string;
  agentId?: string;
  policyKey?: string;
  connectionEpoch?: number;
  authToken?: string | null;
  resourceBasePath?: string;
  resolveArtifactDownload?: ArtifactDownloadResolver;
};

type AttachmentSidebarContent = Omit<AttachmentSidebarSource, "src"> & {
  kind: "attachment";
  attachmentKind?: "audio" | "video" | "document" | "image";
  title: string;
  /** Static sources only; expiring sources are resolved live through resolveSource. */
  src?: string;
  mimeType?: string | null;
  sourceIdentity?: string;
  voiceNote?: boolean;
  plainText?: boolean;
  renderActions?: () => TemplateResult;
  /** Authorize and read fresh bytes for each explicit download. */
  download?: (signal: AbortSignal) => Promise<Blob | null>;
  resolveSource?: (
    onRequestUpdate: () => void,
    runtime: AttachmentSidebarRuntime,
  ) => AttachmentSidebarState;
  rawText?: string | null;
};

type SessionDiffSidebarContent = {
  kind: "session-diff";
  owner: SessionDiffOwner;
  load: SessionDiffLoader;
  loadFileText?: SessionDiffFileTextLoader;
  openFile?: (path: string) => void;
  rawText?: string | null;
};

type FileSaveOutcome =
  | { ok: true; hash: string; updatedAtMs?: number }
  | { ok: false; code: "conflict"; currentHash?: string }
  | { ok: false; code: "error"; message: string };

type FileSidebarEdit = {
  hash: string;
  save: (params: { content: string; expectedHash: string }) => Promise<FileSaveOutcome>;
  /** `editable: false` means the latest content no longer qualifies for edit mode. */
  fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
};

export type FileSidebarNavigation = { line: number };

export type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  /** Stable per-session identity used to retain an unsaved in-memory draft. */
  draftKey?: string;
  /** Captured display context; the draft key is opaque and never a UI label. */
  draftContext?: { sessionKey: string; sessionTitle: string; paneLabel?: string };
  root?: string | null;
  mimeType?: string;
  language?: string;
  line?: number | null;
  /** New identity for an explicit line request; ordinary tab selection retains it. */
  navigation?: FileSidebarNavigation;
  rawText?: string | null;
  edit?: FileSidebarEdit;
};

export type ToolOutputSidebarContent = {
  kind: "tool-output";
  card: ToolCard;
  sessionKey?: string;
  agentId?: string;
};

export type SidebarContent =
  | ToolOutputSidebarContent
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | AttachmentSidebarContent
  | FileSidebarContent
  | SessionDiffSidebarContent;

export type ChatDetailPanelContent = Exclude<SidebarContent, { kind: "tool-output" }>;

export type SidebarSelection = (
  | SidebarContent
  | { kind: "loading" }
  // Keep failed opens attached to their selected surface instead of falling back
  // to unrelated content.
  | { kind: "unavailable"; message: string }
) & { fileTab?: { id: string; label: string } };
