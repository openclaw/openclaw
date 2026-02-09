export type SessionFileType = "csv" | "pdf" | "text" | "json";

export type SessionFileMetadata = {
  id: string;
  filename: string;
  type: SessionFileType;
  uploadedAt: number; // timestamp
  size: number; // bytes
  expiresAt: number; // timestamp (uploadedAt + retentionDays)
  csvSchema?: {
    columns: string[];
    rowCount: number;
  };
};

export type SessionFilesIndex = {
  files: SessionFileMetadata[];
};

export type CsvQueryFilter = {
  column: string;
  operator: "eq" | "gt" | "lt" | "gte" | "lte" | "contains" | "startsWith" | "endsWith";
  value: string | number;
};

export type CsvQueryResult = {
  rows: Record<string, unknown>[];
  total: number;
  columns: string[];
};

export type TextSearchMatch = {
  snippet: string;
  line?: number;
  page?: number;
  context: string;
};
