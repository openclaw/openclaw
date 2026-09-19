/** Passive link-reader models shared by plugins and the Control UI. */
export type ControlUiLinkReaderMetadata = {
  /** Exact lowercase DNS hostnames; no schemes, ports, or wildcards. */
  hosts: string[];
  /** Anchored pathname regular expression authored by the installed trusted plugin. */
  pathPattern: string;
  /** Same-plugin gateway method requiring operator.read. */
  detailMethod: string;
  previewMethod?: string;
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
export type ControlUiLinkReaderDetailParams = { url: string; refresh?: boolean };

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
  createdAt?: string;
  updatedAt?: string;
  metadata?: Array<{ label: string; value: string }>;
  imageUrl?: string;
};

export type ControlUiLinkReaderDocument = ControlUiLinkReaderPreview & {
  /** Markdown rendered through the host's safe passive Markdown renderer. */
  body: string;
  bodyTruncated?: boolean;
  partial?: boolean;
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
