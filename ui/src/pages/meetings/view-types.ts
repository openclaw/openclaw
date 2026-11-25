import type {
  TranscriptsExportParams,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";

type TranscriptReadState = {
  summary: TranscriptsGetResult | null;
  pages: TranscriptsGetResult[];
  read: () => void;
  loading: boolean;
  // Authorization denial clears retained content; ordinary read failures flow through read.
  error: unknown;
};

export type TranscriptsViewProps = {
  basePath: string;
  onFocusTarget?: (
    kind: "search" | "reader-title" | "reader-error",
    element: HTMLElement,
  ) => (() => void) | undefined;
  now: number;
  search: string;
  drafts: Readonly<Record<string, string>>;
  onDraft: (key: string, value: string) => void;
  connected: boolean;
  allowed: boolean;
  list: TranscriptsListResult | null;
  listRead: () => void;
  listLoading: boolean;
  listError: unknown;
  reader: TranscriptReadState;
  readerTab: "text" | "summary";
  summaryGenerating?: boolean;
  summaryCompletion?: Promise<void> | null;
  summaryRead?: () => boolean;
  onSummaryRetry?: () => void;
  exporting: boolean;
  exportCompletion: Promise<void> | null;
  exportRead: () => boolean;
  onNavigate: (patch: Record<string, string | null>) => void;
  onOpenCaptureSettings: () => void;
  onRefresh: () => void;
  onReaderRetry: () => void;
  onReaderTab: (tab: "text" | "summary") => void;
  onDownload: (format: TranscriptsExportParams["format"]) => void;
};
