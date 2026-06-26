// SQLite-backed project workspace store.
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { diagnoseProjectDocumentSummary } from "./project-document-summary.js";
import {
  parseProjectDocumentStatus,
  parseProjectChatStatus,
  parseProjectRoleStatus,
  parseProjectStatus,
  type ProjectChatRecord,
  type ProjectContextRecord,
  type ProjectDetail,
  type ProjectDocumentRecord,
  type ProjectRecord,
  type ProjectRoleRecord,
} from "./project-types.js";

type ProjectsTable = OpenClawStateKyselyDatabase["projects"];
type ProjectChatsTable = OpenClawStateKyselyDatabase["project_chats"];
type ProjectContextsTable = OpenClawStateKyselyDatabase["project_contexts"];
type ProjectDocumentsTable = OpenClawStateKyselyDatabase["project_documents"];
type ProjectRolesTable = OpenClawStateKyselyDatabase["project_roles"];
type ProjectStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "project_chats" | "project_contexts" | "project_documents" | "project_roles" | "projects"
>;

type ProjectRow = Selectable<ProjectsTable>;
type ProjectChatRow = Selectable<ProjectChatsTable>;
type ProjectContextRow = Selectable<ProjectContextsTable>;
type ProjectDocumentRow = Selectable<ProjectDocumentsTable>;
type ProjectRoleRow = Selectable<ProjectRolesTable>;

export type ListProjectsOptions = {
  includeArchived?: boolean;
  limit?: number;
};

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
};

export type PatchProjectInput = {
  name?: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number | null;
  defaultRoleKey?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UpsertProjectChatInput = {
  projectId: string;
  sessionKey: string;
  agentId?: string | null;
  title?: string | null;
  role?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
};

export type PatchProjectChatInput = {
  title?: string | null;
  role?: string | null;
  sortOrder?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type PatchProjectContextInput = {
  summary?: string | null;
  instructions?: string | null;
  decisions?: string[] | null;
  documents?: string[] | null;
};

export type CreateProjectRoleInput = {
  projectId: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
};

export type PatchProjectRoleInput = {
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  sortOrder?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type CreateProjectDocumentInput = {
  projectId: string;
  title: string;
  uri?: string | null;
  kind?: string | null;
  notes?: string | null;
  includeInContext?: boolean;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
};

export type PatchProjectDocumentInput = {
  title?: string | null;
  uri?: string | null;
  kind?: string | null;
  notes?: string | null;
  includeInContext?: boolean | null;
  sortOrder?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type ProjectForSession = {
  project: ProjectRecord;
  chat: ProjectChatRecord;
  role?: ProjectRoleRecord;
  context?: ProjectContextRecord;
  documents?: ProjectDocumentRecord[];
};

const DEFAULT_PROJECT_LIST_LIMIT = 200;
const MAX_PROJECT_LIST_LIMIT = 500;
const DEFAULT_PROJECT_ROLES = [
  {
    roleKey: "implementation",
    name: "Implementation",
    description: "Build, refactor, and verify changes.",
    instructions: [
      "Prioriza cambios concretos de codigo, arquitectura incremental y compatibilidad.",
      "Propone verificaciones y pruebas junto a cada cambio relevante.",
      "Evita redisenos amplios salvo que desbloqueen el objetivo del proyecto.",
    ].join("\n"),
  },
  {
    roleKey: "research",
    name: "Research",
    description: "Explore options, risks, and sources.",
    instructions: [
      "Prioriza exploracion, opciones, riesgos, fuentes y preguntas abiertas.",
      "Separa hechos confirmados de inferencias y supuestos.",
      "Resume hallazgos accionables para otros chats del proyecto.",
    ].join("\n"),
  },
  {
    roleKey: "review",
    name: "Review",
    description: "Find bugs, regressions, and missing tests.",
    instructions: [
      "Prioriza bugs, regresiones, riesgos, casos borde y pruebas faltantes.",
      "Ordena hallazgos por severidad e impacto practico.",
      "Evita reescrituras cosmeticas que no reduzcan riesgo.",
    ].join("\n"),
  },
  {
    roleKey: "planning",
    name: "Planning",
    description: "Scope work, decisions, and next actions.",
    instructions: [
      "Prioriza alcance, decisiones, tradeoffs, secuencia de trabajo y criterios de exito.",
      "Mantiene claridad entre objetivos, pendientes, riesgos y proximas acciones.",
      "Ayuda a convertir conversaciones del proyecto en planes ejecutables.",
    ].join("\n"),
  },
] as const;

function getProjectKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ProjectStoreDatabase>(db);
}

function affectedRows(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

function runProjectWrite(
  operation: (database: ReturnType<typeof openOpenClawStateDatabase>) => void,
): void {
  runOpenClawStateWriteTransaction((database) => operation(database));
}

function createProjectId(): string {
  return `proj_${crypto.randomUUID()}`;
}

function createProjectDocumentId(): string {
  return `doc_${crypto.randomUUID()}`;
}

function slugifyRoleKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "role";
}

function normalizeString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeSortOrder(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(value);
}

function jsonString(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    status: parseProjectStatus(row.status),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.archived_at_ms != null ? { archivedAtMs: row.archived_at_ms } : {}),
    ...(row.color ? { color: row.color } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    sortOrder: row.sort_order,
    ...(row.default_role_key ? { defaultRoleKey: row.default_role_key } : {}),
    ...(parseJsonRecord(row.metadata_json) ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToProjectChat(row: ProjectChatRow): ProjectChatRecord {
  return {
    projectId: row.project_id,
    sessionKey: row.session_key,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.role ? { role: row.role } : {}),
    status: parseProjectChatStatus(row.status),
    sortOrder: row.sort_order,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.archived_at_ms != null ? { archivedAtMs: row.archived_at_ms } : {}),
    ...(parseJsonRecord(row.metadata_json) ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToProjectContext(row: ProjectContextRow): ProjectContextRecord {
  return {
    projectId: row.project_id,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.instructions ? { instructions: row.instructions } : {}),
    decisions: parseStringArray(row.decisions_json),
    documents: parseStringArray(row.documents_json),
    updatedAtMs: row.updated_at_ms,
  };
}

function rowToProjectRole(row: ProjectRoleRow): ProjectRoleRecord {
  return {
    projectId: row.project_id,
    roleKey: row.role_key,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.instructions ? { instructions: row.instructions } : {}),
    status: parseProjectRoleStatus(row.status),
    sortOrder: row.sort_order,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.archived_at_ms != null ? { archivedAtMs: row.archived_at_ms } : {}),
    ...(parseJsonRecord(row.metadata_json) ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToProjectDocument(row: ProjectDocumentRow): ProjectDocumentRecord {
  return {
    projectId: row.project_id,
    documentId: row.document_id,
    title: row.title,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    includeInContext: row.include_in_context === 1,
    status: parseProjectDocumentStatus(row.status),
    sortOrder: row.sort_order,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.archived_at_ms != null ? { archivedAtMs: row.archived_at_ms } : {}),
    ...(parseJsonRecord(row.metadata_json) ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function bindProject(input: CreateProjectInput, now: number): Insertable<ProjectsTable> {
  return {
    project_id: createProjectId(),
    name: normalizeRequiredString(input.name, "name"),
    description: normalizeString(input.description) ?? null,
    status: "active",
    created_at_ms: now,
    updated_at_ms: now,
    archived_at_ms: null,
    color: normalizeString(input.color) ?? null,
    icon: normalizeString(input.icon) ?? null,
    sort_order: normalizeSortOrder(input.sortOrder),
    default_role_key: null,
    metadata_json: jsonString(input.metadata),
  };
}

function projectPatch(input: PatchProjectInput, now: number): Updateable<ProjectsTable> {
  const patch: Updateable<ProjectsTable> = { updated_at_ms: now };
  if (Object.hasOwn(input, "name")) {
    patch.name = input.name == null ? undefined : normalizeRequiredString(input.name, "name");
  }
  if (Object.hasOwn(input, "description")) {
    patch.description = normalizeString(input.description) ?? null;
  }
  if (Object.hasOwn(input, "color")) {
    patch.color = normalizeString(input.color) ?? null;
  }
  if (Object.hasOwn(input, "icon")) {
    patch.icon = normalizeString(input.icon) ?? null;
  }
  if (Object.hasOwn(input, "sortOrder")) {
    patch.sort_order = normalizeSortOrder(input.sortOrder);
  }
  if (Object.hasOwn(input, "defaultRoleKey")) {
    patch.default_role_key = normalizeString(input.defaultRoleKey) ?? null;
  }
  if (Object.hasOwn(input, "metadata")) {
    patch.metadata_json = jsonString(input.metadata);
  }
  return patch;
}

function chatPatch(input: PatchProjectChatInput, now: number): Updateable<ProjectChatsTable> {
  const patch: Updateable<ProjectChatsTable> = { updated_at_ms: now };
  if (Object.hasOwn(input, "title")) {
    patch.title = normalizeString(input.title) ?? null;
  }
  if (Object.hasOwn(input, "role")) {
    patch.role = normalizeString(input.role) ?? null;
  }
  if (Object.hasOwn(input, "sortOrder")) {
    patch.sort_order = normalizeSortOrder(input.sortOrder);
  }
  if (Object.hasOwn(input, "metadata")) {
    patch.metadata_json = jsonString(input.metadata);
  }
  return patch;
}

function contextPatch(
  input: PatchProjectContextInput,
  now: number,
): Insertable<ProjectContextsTable> {
  return {
    project_id: "",
    summary: Object.hasOwn(input, "summary") ? (normalizeString(input.summary) ?? null) : null,
    instructions: Object.hasOwn(input, "instructions")
      ? (normalizeString(input.instructions) ?? null)
      : null,
    decisions_json: Object.hasOwn(input, "decisions") ? jsonString(input.decisions ?? []) : "[]",
    documents_json: Object.hasOwn(input, "documents") ? jsonString(input.documents ?? []) : "[]",
    updated_at_ms: now,
  };
}

function rolePatch(input: PatchProjectRoleInput, now: number): Updateable<ProjectRolesTable> {
  const patch: Updateable<ProjectRolesTable> = { updated_at_ms: now };
  if (Object.hasOwn(input, "name")) {
    patch.name = input.name == null ? undefined : normalizeRequiredString(input.name, "name");
  }
  if (Object.hasOwn(input, "description")) {
    patch.description = normalizeString(input.description) ?? null;
  }
  if (Object.hasOwn(input, "instructions")) {
    patch.instructions = normalizeString(input.instructions) ?? null;
  }
  if (Object.hasOwn(input, "sortOrder")) {
    patch.sort_order = normalizeSortOrder(input.sortOrder);
  }
  if (Object.hasOwn(input, "metadata")) {
    patch.metadata_json = jsonString(input.metadata);
  }
  return patch;
}

function documentPatch(
  input: PatchProjectDocumentInput,
  now: number,
): Updateable<ProjectDocumentsTable> {
  const patch: Updateable<ProjectDocumentsTable> = { updated_at_ms: now };
  if (Object.hasOwn(input, "title")) {
    patch.title = input.title == null ? undefined : normalizeRequiredString(input.title, "title");
  }
  if (Object.hasOwn(input, "uri")) {
    patch.uri = normalizeString(input.uri) ?? null;
  }
  if (Object.hasOwn(input, "kind")) {
    patch.kind = normalizeString(input.kind) ?? null;
  }
  if (Object.hasOwn(input, "notes")) {
    patch.notes = normalizeString(input.notes) ?? null;
  }
  if (Object.hasOwn(input, "includeInContext")) {
    patch.include_in_context = input.includeInContext ? 1 : 0;
  }
  if (Object.hasOwn(input, "sortOrder")) {
    patch.sort_order = normalizeSortOrder(input.sortOrder);
  }
  if (Object.hasOwn(input, "metadata")) {
    patch.metadata_json = jsonString(input.metadata);
  }
  return patch;
}

function getUniqueRoleKey(database: DatabaseSync, projectId: string, name: string): string {
  const base = slugifyRoleKey(name);
  const kysely = getProjectKysely(database);
  for (let index = 0; index < 100; index += 1) {
    const roleKey = index === 0 ? base : `${base}-${index + 1}`;
    const existing = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("project_roles")
        .select("role_key")
        .where("project_id", "=", projectId)
        .where("role_key", "=", roleKey),
    ).rows[0];
    if (!existing) {
      return roleKey;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function seedDefaultProjectRoles(database: DatabaseSync, projectId: string, now: number): void {
  const kysely = getProjectKysely(database);
  const existing = executeSqliteQuerySync(
    database,
    kysely
      .selectFrom("project_roles")
      .select("role_key")
      .where("project_id", "=", projectId)
      .limit(1),
  ).rows[0];
  if (existing) {
    return;
  }
  executeSqliteQuerySync(
    database,
    kysely.insertInto("project_roles").values(
      DEFAULT_PROJECT_ROLES.map((role, index) => ({
        project_id: projectId,
        role_key: role.roleKey,
        name: role.name,
        description: role.description,
        instructions: role.instructions,
        status: "active",
        sort_order: index,
        created_at_ms: now,
        updated_at_ms: now,
        archived_at_ms: null,
        metadata_json: null,
      })),
    ),
  );
}

export function listProjects(options: ListProjectsOptions = {}): ProjectRecord[] {
  const database = openOpenClawStateDatabase();
  let query = getProjectKysely(database.db)
    .selectFrom("projects")
    .selectAll()
    .orderBy("sort_order", "asc")
    .orderBy("updated_at_ms", "desc")
    .orderBy("project_id", "asc");
  if (!options.includeArchived) {
    query = query.where("status", "=", "active");
  }
  const limit = Math.min(options.limit ?? DEFAULT_PROJECT_LIST_LIMIT, MAX_PROJECT_LIST_LIMIT);
  return executeSqliteQuerySync(database.db, query.limit(limit)).rows.map(rowToProject);
}

export function getProject(projectId: string): ProjectDetail | null {
  const database = openOpenClawStateDatabase();
  const kysely = getProjectKysely(database.db);
  const project = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("projects").selectAll().where("project_id", "=", projectId),
  ).rows[0];
  if (!project) {
    return null;
  }
  const context = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("project_contexts").selectAll().where("project_id", "=", projectId),
  ).rows[0];
  return {
    ...rowToProject(project),
    ...(context ? { context: rowToProjectContext(context) } : {}),
  };
}

export function getActiveProjectForSession(
  sessionKey: string | undefined,
): ProjectForSession | null {
  const normalizedSessionKey = normalizeString(sessionKey);
  if (!normalizedSessionKey) {
    return null;
  }
  const database = openOpenClawStateDatabase();
  const kysely = getProjectKysely(database.db);
  const chat = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("project_chats")
      .selectAll()
      .where("session_key", "=", normalizedSessionKey)
      .where("status", "=", "active")
      .orderBy("updated_at_ms", "desc")
      .orderBy("project_id", "asc")
      .limit(1),
  ).rows[0];
  if (!chat) {
    return null;
  }
  const project = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("projects")
      .selectAll()
      .where("project_id", "=", chat.project_id)
      .where("status", "=", "active"),
  ).rows[0];
  if (!project) {
    return null;
  }
  const context = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("project_contexts").selectAll().where("project_id", "=", chat.project_id),
  ).rows[0];
  const documents = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("project_documents")
      .selectAll()
      .where("project_id", "=", chat.project_id)
      .where("status", "=", "active")
      .where("include_in_context", "=", 1)
      .orderBy("sort_order", "asc")
      .orderBy("updated_at_ms", "desc")
      .orderBy("document_id", "asc"),
  ).rows.map(rowToProjectDocument);
  const role = chat.role
    ? executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("project_roles")
          .selectAll()
          .where("project_id", "=", chat.project_id)
          .where("role_key", "=", chat.role)
          .where("status", "=", "active"),
      ).rows[0]
    : undefined;
  return {
    project: rowToProject(project),
    chat: rowToProjectChat(chat),
    ...(role ? { role: rowToProjectRole(role) } : {}),
    ...(context ? { context: rowToProjectContext(context) } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  };
}

export function createProject(input: CreateProjectInput): ProjectRecord {
  const now = Date.now();
  const row = bindProject(input, now);
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db).insertInto("projects").values(row),
    );
    seedDefaultProjectRoles(database.db, row.project_id, now);
  });
  return rowToProject(row as ProjectRow);
}

export function patchProject(projectId: string, input: PatchProjectInput): ProjectRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("projects")
        .set(projectPatch(input, now))
        .where("project_id", "=", projectId),
    );
  });
  return getProject(projectId);
}

export function archiveProject(projectId: string): ProjectRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    const kysely = getProjectKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .updateTable("projects")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", projectId),
    );
    executeSqliteQuerySync(
      database.db,
      kysely
        .updateTable("project_chats")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", projectId),
    );
    executeSqliteQuerySync(
      database.db,
      kysely
        .updateTable("project_roles")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", projectId),
    );
    executeSqliteQuerySync(
      database.db,
      kysely
        .updateTable("project_documents")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", projectId),
    );
  });
  return getProject(projectId);
}

export function restoreProject(projectId: string): ProjectRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("projects")
        .set({ status: "active", archived_at_ms: null, updated_at_ms: now })
        .where("project_id", "=", projectId),
    );
  });
  return getProject(projectId);
}

export function listProjectRoles(params: {
  projectId: string;
  includeArchived?: boolean;
}): ProjectRoleRecord[] {
  runProjectWrite((database) => {
    seedDefaultProjectRoles(database.db, params.projectId, Date.now());
  });
  const database = openOpenClawStateDatabase();
  let query = getProjectKysely(database.db)
    .selectFrom("project_roles")
    .selectAll()
    .where("project_id", "=", params.projectId)
    .orderBy("sort_order", "asc")
    .orderBy("updated_at_ms", "desc")
    .orderBy("role_key", "asc");
  if (!params.includeArchived) {
    query = query.where("status", "=", "active");
  }
  return executeSqliteQuerySync(database.db, query).rows.map(rowToProjectRole);
}

export function getProjectRole(params: {
  projectId: string;
  roleKey: string;
}): ProjectRoleRecord | null {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    database.db,
    getProjectKysely(database.db)
      .selectFrom("project_roles")
      .selectAll()
      .where("project_id", "=", params.projectId)
      .where("role_key", "=", params.roleKey),
  ).rows[0];
  return row ? rowToProjectRole(row) : null;
}

export function createProjectRole(input: CreateProjectRoleInput): ProjectRoleRecord | null {
  const now = Date.now();
  const projectId = normalizeRequiredString(input.projectId, "projectId");
  const name = normalizeRequiredString(input.name, "name");
  let roleKey = "";
  runProjectWrite((database) => {
    roleKey = getUniqueRoleKey(database.db, projectId, name);
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .insertInto("project_roles")
        .values({
          project_id: projectId,
          role_key: roleKey,
          name,
          description: normalizeString(input.description) ?? null,
          instructions: normalizeString(input.instructions) ?? null,
          status: "active",
          sort_order: normalizeSortOrder(input.sortOrder),
          created_at_ms: now,
          updated_at_ms: now,
          archived_at_ms: null,
          metadata_json: jsonString(input.metadata),
        }),
    );
  });
  return getProjectRole({ projectId, roleKey });
}

export function patchProjectRole(params: {
  projectId: string;
  roleKey: string;
  patch: PatchProjectRoleInput;
}): ProjectRoleRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_roles")
        .set(rolePatch(params.patch, now))
        .where("project_id", "=", params.projectId)
        .where("role_key", "=", params.roleKey),
    );
  });
  return getProjectRole(params);
}

export function archiveProjectRole(params: {
  projectId: string;
  roleKey: string;
}): ProjectRoleRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_roles")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("role_key", "=", params.roleKey),
    );
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("projects")
        .set({ default_role_key: null, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("default_role_key", "=", params.roleKey),
    );
  });
  return getProjectRole(params);
}

export function restoreProjectRole(params: {
  projectId: string;
  roleKey: string;
}): ProjectRoleRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_roles")
        .set({ status: "active", archived_at_ms: null, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("role_key", "=", params.roleKey),
    );
  });
  return getProjectRole(params);
}

export function listProjectDocuments(params: {
  projectId: string;
  includeArchived?: boolean;
}): ProjectDocumentRecord[] {
  const database = openOpenClawStateDatabase();
  let query = getProjectKysely(database.db)
    .selectFrom("project_documents")
    .selectAll()
    .where("project_id", "=", params.projectId)
    .orderBy("sort_order", "asc")
    .orderBy("updated_at_ms", "desc")
    .orderBy("document_id", "asc");
  if (!params.includeArchived) {
    query = query.where("status", "=", "active");
  }
  return executeSqliteQuerySync(database.db, query).rows.map((row) => {
    const document = rowToProjectDocument(row);
    return { ...document, summaryDiagnostic: diagnoseProjectDocumentSummary(document) };
  });
}

export function getProjectDocument(params: {
  projectId: string;
  documentId: string;
}): ProjectDocumentRecord | null {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    database.db,
    getProjectKysely(database.db)
      .selectFrom("project_documents")
      .selectAll()
      .where("project_id", "=", params.projectId)
      .where("document_id", "=", params.documentId),
  ).rows[0];
  return row ? rowToProjectDocument(row) : null;
}

export function createProjectDocument(
  input: CreateProjectDocumentInput,
): ProjectDocumentRecord | null {
  const now = Date.now();
  const projectId = normalizeRequiredString(input.projectId, "projectId");
  const documentId = createProjectDocumentId();
  const row: Insertable<ProjectDocumentsTable> = {
    project_id: projectId,
    document_id: documentId,
    title: normalizeRequiredString(input.title, "title"),
    uri: normalizeString(input.uri) ?? null,
    kind: normalizeString(input.kind) ?? null,
    notes: normalizeString(input.notes) ?? null,
    include_in_context: input.includeInContext === false ? 0 : 1,
    status: "active",
    sort_order: normalizeSortOrder(input.sortOrder),
    created_at_ms: now,
    updated_at_ms: now,
    archived_at_ms: null,
    metadata_json: jsonString(input.metadata),
  };
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db).insertInto("project_documents").values(row),
    );
  });
  return getProjectDocument({ projectId, documentId });
}

export function patchProjectDocument(params: {
  projectId: string;
  documentId: string;
  patch: PatchProjectDocumentInput;
}): ProjectDocumentRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_documents")
        .set(documentPatch(params.patch, now))
        .where("project_id", "=", params.projectId)
        .where("document_id", "=", params.documentId),
    );
  });
  return getProjectDocument(params);
}

export function archiveProjectDocument(params: {
  projectId: string;
  documentId: string;
}): ProjectDocumentRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_documents")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("document_id", "=", params.documentId),
    );
  });
  return getProjectDocument(params);
}

export function restoreProjectDocument(params: {
  projectId: string;
  documentId: string;
}): ProjectDocumentRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_documents")
        .set({ status: "active", archived_at_ms: null, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("document_id", "=", params.documentId),
    );
  });
  return getProjectDocument(params);
}

export function listProjectChats(params: {
  projectId: string;
  includeArchived?: boolean;
}): ProjectChatRecord[] {
  const database = openOpenClawStateDatabase();
  let query = getProjectKysely(database.db)
    .selectFrom("project_chats")
    .selectAll()
    .where("project_id", "=", params.projectId)
    .orderBy("sort_order", "asc")
    .orderBy("updated_at_ms", "desc")
    .orderBy("session_key", "asc");
  if (!params.includeArchived) {
    query = query.where("status", "=", "active");
  }
  return executeSqliteQuerySync(database.db, query).rows.map(rowToProjectChat);
}

export function upsertProjectChat(input: UpsertProjectChatInput): ProjectChatRecord | null {
  const now = Date.now();
  const projectId = normalizeRequiredString(input.projectId, "projectId");
  const sessionKey = normalizeRequiredString(input.sessionKey, "sessionKey");
  const row: Insertable<ProjectChatsTable> = {
    project_id: projectId,
    session_key: sessionKey,
    agent_id: normalizeString(input.agentId) ?? null,
    title: normalizeString(input.title) ?? null,
    role: normalizeString(input.role) ?? null,
    status: "active",
    sort_order: normalizeSortOrder(input.sortOrder),
    created_at_ms: now,
    updated_at_ms: now,
    archived_at_ms: null,
    metadata_json: jsonString(input.metadata),
  };
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .insertInto("project_chats")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["project_id", "session_key"]).doUpdateSet({
            agent_id: row.agent_id,
            title: row.title,
            role: row.role,
            status: "active",
            sort_order: row.sort_order,
            updated_at_ms: now,
            archived_at_ms: null,
            metadata_json: row.metadata_json,
          }),
        ),
    );
  });
  return (
    listProjectChats({ projectId, includeArchived: true }).find(
      (chat) => chat.sessionKey === sessionKey,
    ) ?? null
  );
}

export function patchProjectChat(params: {
  projectId: string;
  sessionKey: string;
  patch: PatchProjectChatInput;
}): ProjectChatRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_chats")
        .set(chatPatch(params.patch, now))
        .where("project_id", "=", params.projectId)
        .where("session_key", "=", params.sessionKey),
    );
  });
  return (
    listProjectChats({ projectId: params.projectId, includeArchived: true }).find(
      (chat) => chat.sessionKey === params.sessionKey,
    ) ?? null
  );
}

export function archiveProjectChat(params: {
  projectId: string;
  sessionKey: string;
}): ProjectChatRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_chats")
        .set({ status: "archived", archived_at_ms: now, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("session_key", "=", params.sessionKey),
    );
  });
  return (
    listProjectChats({ projectId: params.projectId, includeArchived: true }).find(
      (chat) => chat.sessionKey === params.sessionKey,
    ) ?? null
  );
}

export function restoreProjectChat(params: {
  projectId: string;
  sessionKey: string;
}): ProjectChatRecord | null {
  const now = Date.now();
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .updateTable("project_chats")
        .set({ status: "active", archived_at_ms: null, updated_at_ms: now })
        .where("project_id", "=", params.projectId)
        .where("session_key", "=", params.sessionKey),
    );
  });
  return (
    listProjectChats({ projectId: params.projectId, includeArchived: true }).find(
      (chat) => chat.sessionKey === params.sessionKey,
    ) ?? null
  );
}

export function detachProjectChat(params: { projectId: string; sessionKey: string }): boolean {
  let changed = false;
  runProjectWrite((database) => {
    const result = executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .deleteFrom("project_chats")
        .where("project_id", "=", params.projectId)
        .where("session_key", "=", params.sessionKey),
    );
    changed = affectedRows(result) > 0;
  });
  return changed;
}

export function getProjectContext(projectId: string): ProjectContextRecord | null {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    database.db,
    getProjectKysely(database.db)
      .selectFrom("project_contexts")
      .selectAll()
      .where("project_id", "=", projectId),
  ).rows[0];
  return row ? rowToProjectContext(row) : null;
}

export function patchProjectContext(
  projectId: string,
  input: PatchProjectContextInput,
): ProjectContextRecord | null {
  const now = Date.now();
  const current = getProjectContext(projectId);
  const patch = contextPatch(input, now);
  const row: Insertable<ProjectContextsTable> = {
    project_id: projectId,
    summary: Object.hasOwn(input, "summary") ? patch.summary : (current?.summary ?? null),
    instructions: Object.hasOwn(input, "instructions")
      ? patch.instructions
      : (current?.instructions ?? null),
    decisions_json: Object.hasOwn(input, "decisions")
      ? patch.decisions_json
      : jsonString(current?.decisions ?? []),
    documents_json: Object.hasOwn(input, "documents")
      ? patch.documents_json
      : jsonString(current?.documents ?? []),
    updated_at_ms: now,
  };
  runProjectWrite((database) => {
    executeSqliteQuerySync(
      database.db,
      getProjectKysely(database.db)
        .insertInto("project_contexts")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("project_id").doUpdateSet({
            summary: row.summary,
            instructions: row.instructions,
            decisions_json: row.decisions_json,
            documents_json: row.documents_json,
            updated_at_ms: now,
          }),
        ),
    );
  });
  return getProjectContext(projectId);
}
