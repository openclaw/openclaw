import type {
  TranscriptsExportParams,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";

export type TranscriptReadState = {
  summary: TranscriptsGetResult | null;
  pages: TranscriptsGetResult[];
  loading: boolean;
  error: unknown;
};

export type TranscriptsViewProps = {
  basePath: string;
  now: number;
  search: string;
  drafts: Readonly<Record<string, string>>;
  onDraft: (key: string, value: string) => void;
  connected: boolean;
  allowed: boolean;
  list: TranscriptsListResult | null;
  listLoading: boolean;
  listError: unknown;
  reader: TranscriptReadState;
  readerTab: "text" | "summary";
  summaryGeneration?: { kind: "idle" | "loading" | "done" | "error"; message?: string };
  onSummaryRetry?: () => void;
  exportState: { kind: "idle" | "loading" | "done" | "error"; message?: string };
  onNavigate: (patch: Record<string, string | null>) => void;
  onRefresh: () => void;
  onReaderRetry: () => void;
  onReaderTab: (tab: "text" | "summary") => void;
  onDownload: (format: TranscriptsExportParams["format"]) => void;
};
