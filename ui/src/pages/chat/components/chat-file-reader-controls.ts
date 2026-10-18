import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import type { EditorId } from "../../../lib/editor-links.ts";
import type { FileCopyAction, FileCopyFeedback } from "./chat-file-copy.ts";
import type { FileHtmlPreviewControls } from "./chat-html-preview.ts";
import type {
  AttachmentSidebarRuntime,
  FileReaderWorkspace,
  FileSidebarContent,
  MobileFileBack,
} from "./chat-sidebar-content-types.ts";

export type MobileFileFindCloseReason = "close" | "escape" | "outside";

export type FileReadingMode = "preview" | "highlighted" | "plain";

export type FileReaderChromeProps = {
  content: FileSidebarContent;
  controls: FileViewControls;
  runtime?: AttachmentSidebarRuntime;
};

export type FileViewControls = {
  presentation?: "desktop" | "mobile";
  back?: MobileFileBack;
  active?: boolean;
  workspace?: FileReaderWorkspace;
  onCloseSearch?: (reason: MobileFileFindCloseReason) => void;
  readingMode?: FileReadingMode;
  imagePreview?: { content: string };
  markdown?: { content: string; options: MarkdownRenderOptions };
  onReadingModeChange?: (mode: FileReadingMode) => void;
  onSelectContent?: () => void;
  htmlPreview?: FileHtmlPreviewControls;
  copyFeedback: FileCopyFeedback;
  editorRef?: (element: HTMLElement) => void;
  searchInputRef?: (element: HTMLInputElement) => void;
  searchToggleRef?: (target: HTMLButtonElement | (() => HTMLButtonElement | undefined)) => void;
  currentMatchIndex: number;
  dirty: boolean;
  execNode: string | null;
  editorMenuOpen: boolean;
  editing: boolean;
  loadingEditor: boolean;
  mountKey: number;
  matches: number[];
  query: string;
  saveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null;
  saving: boolean;
  searchOpen: boolean;
  wrap: boolean;
  onCopy: (action: FileCopyAction) => void;
  onDiscard: () => void;
  onEdit: () => void;
  onNextMatch: () => void;
  onOpenEditor: (editor: EditorId) => void;
  onOverwrite: () => void;
  onPreviousMatch: () => void;
  onReload: () => void;
  onReveal?: (path: string) => void;
  onSave: () => void;
  onSearchInput: (query: string) => void;
  onSearchKeydown: (event: KeyboardEvent) => void;
  onEditorMenuOpenChange: (open: boolean) => void;
  onToggleSearch: () => void;
  onToggleWrap: () => void;
};
