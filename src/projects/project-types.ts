// Project workspace domain types used by the core project store and gateway methods.

export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_CHAT_STATUSES = ["active", "archived"] as const;
export type ProjectChatStatus = (typeof PROJECT_CHAT_STATUSES)[number];

export const PROJECT_ROLE_STATUSES = ["active", "archived"] as const;
export type ProjectRoleStatus = (typeof PROJECT_ROLE_STATUSES)[number];

export const PROJECT_DOCUMENT_STATUSES = ["active", "archived"] as const;
export type ProjectDocumentStatus = (typeof PROJECT_DOCUMENT_STATUSES)[number];

export const PROJECT_DOCUMENT_IDS_METADATA_KEY = "projectDocumentIds";

export type ProjectRecord = {
  projectId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
  color?: string;
  icon?: string;
  sortOrder: number;
  defaultRoleKey?: string;
  metadata?: Record<string, unknown>;
};

export type ProjectChatRecord = {
  projectId: string;
  sessionKey: string;
  agentId?: string;
  title?: string;
  role?: string;
  status: ProjectChatStatus;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
  metadata?: Record<string, unknown>;
};

export type ProjectContextRecord = {
  projectId: string;
  summary?: string;
  instructions?: string;
  decisions: string[];
  documents: string[];
  updatedAtMs: number;
};

export type ProjectRoleRecord = {
  projectId: string;
  roleKey: string;
  name: string;
  description?: string;
  instructions?: string;
  status: ProjectRoleStatus;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
  metadata?: Record<string, unknown>;
};

export type ProjectDocumentRecord = {
  projectId: string;
  documentId: string;
  title: string;
  uri?: string;
  kind?: string;
  notes?: string;
  includeInContext: boolean;
  status: ProjectDocumentStatus;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
  metadata?: Record<string, unknown>;
  summaryDiagnostic?: {
    status:
      | "summarized"
      | "eligible"
      | "not_needed"
      | "unsupported"
      | "remote"
      | "missing"
      | "unreadable";
    label: string;
    reason: string;
    uriKind: "none" | "local" | "file" | "obsidian" | "remote";
    cache: "hit" | "missing" | "stale" | "not_applicable";
    injectsSummary: boolean;
    filePath?: string;
    extension?: string;
    sizeBytes?: number;
    mtimeMs?: number;
  };
};

export type ProjectDetail = ProjectRecord & {
  context?: ProjectContextRecord;
};

export function parseProjectStatus(value: string | null | undefined): ProjectStatus {
  return value === "archived" ? "archived" : "active";
}

export function parseProjectChatStatus(value: string | null | undefined): ProjectChatStatus {
  return value === "archived" ? "archived" : "active";
}

export function parseProjectRoleStatus(value: string | null | undefined): ProjectRoleStatus {
  return value === "archived" ? "archived" : "active";
}

export function parseProjectDocumentStatus(
  value: string | null | undefined,
): ProjectDocumentStatus {
  return value === "archived" ? "archived" : "active";
}

export function projectDocumentIdsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const value = metadata?.[PROJECT_DOCUMENT_IDS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}
