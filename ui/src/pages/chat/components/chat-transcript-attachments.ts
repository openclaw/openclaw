import type {
  AssistantAttachmentItem,
  ImageBlock,
  ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export type TranscriptAttachmentEntry = {
  key: string;
  label: string;
  mimeType?: string;
  options: ImageRenderOptions;
  onOpenSidebar: (content: SidebarContent) => void;
} & ({ kind: "image"; image: ImageBlock } | { kind: "attachment"; item: AssistantAttachmentItem });

export type TranscriptAttachments = {
  /** Producer deadlines, keyed exactly as the native bubble expiry resource. */
  pairingQrExpirations: readonly { messageKey: string; nextPairingQrExpiresAt: number }[];
  mediaOwner?: object;
  /** Reprojects the same loaded window; no history or media request. */
  refresh: () => TranscriptAttachments;
  entries: readonly TranscriptAttachmentEntry[];
  coverage: "complete" | "partial" | "unknown";
  loading: boolean;
  error?: string;
  omittedMedia: boolean;
};
