/**
 * Project Context — Type definitions and error contracts
 *
 * These types define the ProjectStore interface and RPC contracts
 * for project management in the gateway.
 *
 * Phase 1: MarkdownProjectStore (reads/writes PROJECTS.md)
 * Phase 2: SqliteProjectStore (backed by registry.db)
 */

// ── Project Registry Types ──────────────────────────────────────────

export type ProjectEntry = {
  /** Short ID used for matching (e.g., "subzero") */
  id: string;
  /** Display name (e.g., "Subzero App") */
  name: string;
  /** Absolute path on disk */
  path: string;
  /** Project type descriptor (e.g., "web app", "mobile", "api", "framework") */
  type: string;
  /** One-line tech stack (e.g., "TypeScript, ESM, Bun, Vitest, pnpm") */
  tech: string;
  /** Current status (e.g., "active", "paused", "mvp", "archived") */
  status: string;
  /** Fallback project when context is ambiguous */
  isDefault: boolean;
  /** Additional matching terms for project detection */
  keywords: string[];
  /** Telegram channel binding (group name + topic ID) */
  telegram?: { group?: string; topicId?: number };
};

export type ProjectDetails = ProjectEntry & {
  /** Contents of .openclaw/SOUL.md (null if missing) */
  soul: string | null;
  /** Contents of .openclaw/AGENTS.md (null if missing) */
  agents: string | null;
  /** Contents of .openclaw/TOOLS.md (null if missing) */
  tools: string | null;
};

// ── ProjectStore Interface ──────────────────────────────────────────

export type ProjectStore = {
  /** List all registered projects */
  list(): Promise<ProjectEntry[]>;
  /** Get full project details including .openclaw/ file contents */
  get(id: string): Promise<ProjectDetails>;
  /** Register a new project */
  add(entry: ProjectEntry): Promise<void>;
  /** Update a project entry (partial update) */
  update(id: string, patch: Partial<ProjectEntry>): Promise<void>;
  /** Archive a project (sets status to "archived") */
  archive(id: string): Promise<void>;
};

// ── Session Binding Types ───────────────────────────────────────────

export type BindSessionRequest = {
  sessionKey: string;
  projectId: string;
};

export type BindSessionResult = {
  projectId: string;
  path: string;
  injectedMessage: string;
};

export type UnbindSessionRequest = {
  sessionKey: string;
};

export type GetContextRequest = {
  sessionKey: string;
};

// ── Error Contracts ─────────────────────────────────────────────────

export const ProjectErrorCodes = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  NO_WORKSPACE: "NO_WORKSPACE",
  DUPLICATE_ID: "DUPLICATE_ID",
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  MULTIPLE_DEFAULTS: "MULTIPLE_DEFAULTS",
} as const;

export type ProjectErrorCode = (typeof ProjectErrorCodes)[keyof typeof ProjectErrorCodes];

export type ProjectError = {
  code: ProjectErrorCode;
  message: string;
};
