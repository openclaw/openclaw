/** Passive link-reader models shared by plugins and the Control UI. */
export type ControlUiLinkReaderMetadata = {
  /** Exact lowercase DNS hostnames; no schemes, ports, or wildcards. */
  hosts: string[];
  /** Anchored pathname regular expression authored by the installed trusted plugin. */
  pathPattern: string;
  /** Same-plugin gateway method requiring operator.read. */
  detailMethod: string;
  previewMethod?: string;
  /** Optional same-plugin read method resolving inline images without browser CORS. */
  imageMethod?: string;
};

/** Scope-filtered descriptor advertised in hello.controlUiLinkReaders. */
export type ControlUiLinkReaderDescriptor = {
  pluginId: string;
  id: string;
  label: string;
  /** Existing Control UI icon name; unknown names use the generic link icon. */
  icon?: string;
  linkReader: ControlUiLinkReaderMetadata;
};

export type ControlUiLinkReaderPreviewParams = {
  url: string;
  /** Selected agent hint; the receiving owner still authorizes identity selection. */
  agentId?: string;
};
export type ControlUiLinkReaderDetailParams = ControlUiLinkReaderPreviewParams & {
  refresh?: boolean;
};
export type ControlUiLinkReaderImage = {
  /** Echo the validated requested image URL. */
  url: string;
  /** Canonical base64 data URL for a bounded, validated raster image; never SVG or HTML. */
  dataUrl: string;
};

export type ControlUiLinkReaderPreview = {
  /** Echo the validated requested URL; query parameters remain part of the resource identity. */
  url: string;
  title: string;
  subtitle?: string;
  badge?: {
    label: string;
    tone: "neutral" | "positive" | "negative" | "attention" | "accent";
  };
  author?: string;
  /** Optional HTTPS profile link on the source origin. */
  authorUrl?: string;
  coAuthors?: Array<{ name: string; imageUrl?: string }>;
  /** Total including authors omitted from the bounded coAuthors array. */
  coAuthorCount?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Array<{ label: string; value: string; tone?: "positive" | "negative" }>;
  imageUrl?: string;
};

export type ControlUiLinkReaderDocument = ControlUiLinkReaderPreview & {
  /** Markdown rendered through the host's safe passive Markdown renderer. */
  body: string;
  bodyTruncated?: boolean;
  partial?: boolean;
  /** Passive provider-reported checks, not a mergeability or approval decision. */
  checks?: {
    state: "success" | "failure" | "pending" | "neutral" | "unavailable";
    summary: string;
    /** Known total; may be incomplete when truncated or unavailable. */
    total: number;
    items: Array<{
      name: string;
      state: "success" | "failure" | "pending" | "neutral";
      detail?: string;
      url?: string;
    }>;
    /** The item list is incomplete, including when a source could not be read. */
    truncated?: boolean;
    url?: string;
    /** Exact source revision these checks describe, when available. */
    commit?: string;
  };
  comments?: Array<{
    id: string;
    url: string;
    author: string;
    createdAt?: string;
    body: string;
    bodyTruncated?: boolean;
    label?: string;
    context?: {
      path?: string;
      lineLabel?: string;
      label?: string;
      diff?: string;
      diffTruncated?: boolean;
      replyUrl?: string;
      replyLabel?: string;
    };
  }>;
  commentsTotal?: number;
  commentsTruncated?: boolean;
  files?: Array<{
    path: string;
    previousPath?: string;
    status?: string;
    additions: number;
    deletions: number;
    patch?: string;
    patchTruncated?: boolean;
  }>;
  filesTotal?: number;
  filesTruncated?: boolean;
  /** Plugin-selected initial file view; the host does not interpret service URL paths. */
  filesExpanded?: boolean;
};
