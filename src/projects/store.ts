import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath, truncateUtf16Safe } from "../utils.js";

export type ProjectMemoryMode = "project_only" | "shared";
export type ProjectResourceKind = "file" | "note";
export type ProjectResourceStatus = "ready" | "unsupported" | "error";

export type ProjectResourceRecord = {
  id: string;
  projectId: string;
  name: string;
  kind: ProjectResourceKind;
  sourceType: "local_file" | "uploaded_file" | "manual";
  sourcePath?: string;
  extension?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256: string;
  status: ProjectResourceStatus;
  error?: string;
  text?: string;
  textPreview?: string;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  indexedAt?: number;
};

export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  color?: string;
  emoji?: string;
  memoryMode: ProjectMemoryMode;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  resources: ProjectResourceRecord[];
};

export type ProjectsStore = {
  version: 1;
  projects: ProjectRecord[];
};

export type ProjectContextBlock = {
  kind: "instructions" | "resource";
  title: string;
  text: string;
  tokenEstimate: number;
  resourceId?: string;
  score?: number;
};

export type ProjectContextPreview = {
  project: ProjectRecord;
  blocks: ProjectContextBlock[];
  resourcesIncluded: ProjectResourceRecord[];
  totalTokenEstimate: number;
  truncated: boolean;
};

const STORE_VERSION = 1;
const PROJECTS_DIRNAME = "projects";
const PROJECTS_STORE_FILENAME = "projects.json";
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_TEXT_CHARS = 120_000;
const DEFAULT_CONTEXT_MAX_CHARS = 16_000;
const DEFAULT_CONTEXT_MAX_RESOURCES = 6;

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".md",
  ".markdown",
  ".py",
  ".text",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export class ProjectsStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "unavailable",
  ) {
    super(message);
  }
}

export function resolveProjectsStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), PROJECTS_DIRNAME, PROJECTS_STORE_FILENAME);
}

export async function loadProjectsStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectsStore> {
  const storePath = resolveProjectsStorePath(env);
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectsStore>;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.projects)) {
      throw new ProjectsStoreError("invalid projects store", "invalid");
    }
    return {
      version: STORE_VERSION,
      projects: parsed.projects.map(normalizeProjectRecord).filter(Boolean) as ProjectRecord[],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { version: STORE_VERSION, projects: [] };
    }
    if (err instanceof ProjectsStoreError) {
      throw err;
    }
    throw new ProjectsStoreError(
      `failed to load projects store: ${formatError(err)}`,
      "unavailable",
    );
  }
}

export async function saveProjectsStore(
  store: ProjectsStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const storePath = resolveProjectsStorePath(env);
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, storePath);
}

export async function listProjects(params?: {
  includeArchived?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord[]> {
  const store = await loadProjectsStore(params?.env);
  return store.projects
    .filter((project) => params?.includeArchived === true || project.archived !== true)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(
  projectId: string,
  env?: NodeJS.ProcessEnv,
): Promise<ProjectRecord> {
  const id = normalizeProjectId(projectId);
  const store = await loadProjectsStore(env);
  const project = store.projects.find((entry) => entry.id === id && entry.archived !== true);
  if (!project) {
    throw new ProjectsStoreError(`project not found: ${projectId}`, "not_found");
  }
  return project;
}

export async function createProject(params: {
  name: string;
  description?: string;
  instructions?: string;
  memoryMode?: ProjectMemoryMode;
  color?: string;
  emoji?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord> {
  const name = normalizeRequiredText(params.name, "name");
  const now = Date.now();
  const store = await loadProjectsStore(params.env);
  const project: ProjectRecord = {
    id: buildProjectId(
      name,
      store.projects.map((entry) => entry.id),
    ),
    name,
    description: normalizeOptionalString(params.description),
    instructions: normalizeOptionalString(params.instructions),
    color: normalizeOptionalString(params.color),
    emoji: normalizeOptionalString(params.emoji),
    memoryMode: params.memoryMode === "shared" ? "shared" : "project_only",
    createdAt: now,
    updatedAt: now,
    resources: [],
  };
  store.projects.push(project);
  await saveProjectsStore(store, params.env);
  return project;
}

export async function updateProject(params: {
  projectId: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  memoryMode?: ProjectMemoryMode;
  color?: string | null;
  emoji?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  if ("name" in params && params.name !== undefined) {
    project.name = params.name === null ? project.name : normalizeRequiredText(params.name, "name");
  }
  if ("description" in params) {
    assignOptionalText(project, "description", params.description);
  }
  if ("instructions" in params) {
    assignOptionalText(project, "instructions", params.instructions);
  }
  if ("color" in params) {
    assignOptionalText(project, "color", params.color);
  }
  if ("emoji" in params) {
    assignOptionalText(project, "emoji", params.emoji);
  }
  if (params.memoryMode === "project_only" || params.memoryMode === "shared") {
    project.memoryMode = params.memoryMode;
  }
  project.updatedAt = Date.now();
  await saveProjectsStore(store, params.env);
  return project;
}

export async function archiveProject(params: {
  projectId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  project.archived = true;
  project.updatedAt = Date.now();
  await saveProjectsStore(store, params.env);
  return project;
}

export async function restoreProject(params: {
  projectId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId, { includeArchived: true });
  delete project.archived;
  project.updatedAt = Date.now();
  await saveProjectsStore(store, params.env);
  return project;
}

export async function addProjectResource(params: {
  projectId: string;
  name?: string;
  path?: string;
  content?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectResourceRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  const extracted = await extractResourceText(params);
  const resource = buildResourceRecord(project.id, extracted);
  project.resources.unshift(resource);
  project.updatedAt = resource.createdAt;
  await saveProjectsStore(store, params.env);
  return resource;
}

export async function addUploadedProjectResource(params: {
  projectId: string;
  name?: string;
  fileName: string;
  mediaType?: string;
  contentBase64: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectResourceRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  const extracted = await extractUploadedResourceText(params);
  const resource = buildResourceRecord(project.id, extracted);
  project.resources.unshift(resource);
  project.updatedAt = resource.createdAt;
  await saveProjectsStore(store, params.env);
  return resource;
}

function buildResourceRecord(
  projectId: string,
  extracted: Awaited<ReturnType<typeof extractResourceText>>,
): ProjectResourceRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    projectId,
    name: extracted.name,
    kind: extracted.sourceType === "manual" ? "note" : "file",
    sourceType: extracted.sourceType,
    sourcePath: extracted.sourcePath,
    extension: extracted.extension,
    mediaType: extracted.mediaType,
    sizeBytes: extracted.sizeBytes,
    sha256: extracted.sha256,
    status: extracted.status,
    error: extracted.error,
    text: extracted.text,
    textPreview: makeTextPreview(extracted.text ?? extracted.error ?? ""),
    tokenEstimate: estimateTokens(extracted.text ?? ""),
    createdAt: now,
    updatedAt: now,
    indexedAt: extracted.status === "ready" ? now : undefined,
  };
}

export async function removeProjectResource(params: {
  projectId: string;
  resourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  const before = project.resources.length;
  project.resources = project.resources.filter((entry) => entry.id !== params.resourceId);
  if (project.resources.length === before) {
    throw new ProjectsStoreError(`resource not found: ${params.resourceId}`, "not_found");
  }
  project.updatedAt = Date.now();
  await saveProjectsStore(store, params.env);
  return project;
}

export async function reindexProjectResource(params: {
  projectId: string;
  resourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectResourceRecord> {
  const store = await loadProjectsStore(params.env);
  const project = findProjectRecord(store, params.projectId);
  const index = project.resources.findIndex((entry) => entry.id === params.resourceId);
  if (index < 0) {
    throw new ProjectsStoreError(`resource not found: ${params.resourceId}`, "not_found");
  }
  const existing = project.resources[index];
  if (existing.sourceType !== "local_file" || !existing.sourcePath) {
    existing.updatedAt = Date.now();
    existing.indexedAt = existing.status === "ready" ? existing.updatedAt : existing.indexedAt;
    await saveProjectsStore(store, params.env);
    return existing;
  }
  const extracted = await extractResourceText({
    projectId: project.id,
    path: existing.sourcePath,
    name: existing.name,
    env: params.env,
  });
  const now = Date.now();
  const next: ProjectResourceRecord = {
    ...existing,
    name: extracted.name,
    sourcePath: extracted.sourcePath,
    extension: extracted.extension,
    mediaType: extracted.mediaType,
    sizeBytes: extracted.sizeBytes,
    sha256: extracted.sha256,
    status: extracted.status,
    error: extracted.error,
    text: extracted.text,
    textPreview: makeTextPreview(extracted.text ?? extracted.error ?? ""),
    tokenEstimate: estimateTokens(extracted.text ?? ""),
    updatedAt: now,
    indexedAt: extracted.status === "ready" ? now : existing.indexedAt,
  };
  project.resources[index] = next;
  project.updatedAt = now;
  await saveProjectsStore(store, params.env);
  return next;
}

export function buildProjectContextPreview(
  project: ProjectRecord,
  opts?: { query?: string; maxChars?: number; maxResources?: number },
): ProjectContextPreview {
  const maxChars = clampInteger(opts?.maxChars, 1000, 80_000, DEFAULT_CONTEXT_MAX_CHARS);
  const maxResources = clampInteger(opts?.maxResources, 1, 20, DEFAULT_CONTEXT_MAX_RESOURCES);
  const blocks: ProjectContextBlock[] = [];
  let usedChars = 0;
  let truncated = false;

  const instructions = normalizeOptionalString(project.instructions);
  if (instructions) {
    const text = takeWithinBudget(instructions, maxChars - usedChars);
    usedChars += text.length;
    truncated = truncated || text.length < instructions.length;
    blocks.push({
      kind: "instructions",
      title: "Project instructions",
      text,
      tokenEstimate: estimateTokens(text),
    });
  }

  const scored = project.resources
    .filter((resource) => resource.status === "ready" && normalizeOptionalString(resource.text))
    .map((resource) => ({
      resource,
      score: scoreResource(resource, opts?.query),
    }))
    .toSorted((a, b) => b.score - a.score || b.resource.updatedAt - a.resource.updatedAt)
    .slice(0, maxResources);

  const resourcesIncluded: ProjectResourceRecord[] = [];
  for (const { resource, score } of scored) {
    const fullText = normalizeOptionalString(resource.text) ?? "";
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = takeWithinBudget(fullText, remaining);
    usedChars += text.length;
    truncated = truncated || text.length < fullText.length;
    resourcesIncluded.push(resource);
    blocks.push({
      kind: "resource",
      title: resource.name,
      text,
      tokenEstimate: estimateTokens(text),
      resourceId: resource.id,
      score,
    });
  }

  return {
    project,
    blocks,
    resourcesIncluded,
    totalTokenEstimate: blocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
    truncated,
  };
}

export function sanitizeProjectForClient(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    resources: project.resources.map(sanitizeResourceForClient),
  };
}

export function sanitizeResourceForClient(resource: ProjectResourceRecord): ProjectResourceRecord {
  const rest = { ...resource };
  delete rest.text;
  return {
    ...rest,
    text: undefined,
  };
}

function normalizeProjectRecord(raw: unknown): ProjectRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Partial<ProjectRecord>;
  const id = normalizeProjectId(record.id);
  const name = normalizeOptionalString(record.name);
  if (!id || !name) {
    return null;
  }
  const createdAt = normalizeTimestamp(record.createdAt);
  const updatedAt = normalizeTimestamp(record.updatedAt);
  return {
    id,
    name,
    description: normalizeOptionalString(record.description),
    instructions: normalizeOptionalString(record.instructions),
    color: normalizeOptionalString(record.color),
    emoji: normalizeOptionalString(record.emoji),
    memoryMode: record.memoryMode === "shared" ? "shared" : "project_only",
    archived: record.archived === true ? true : undefined,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    resources: Array.isArray(record.resources)
      ? record.resources.map((entry) => normalizeResourceRecord(entry, id)).filter(Boolean)
      : [],
  } as ProjectRecord;
}

function normalizeResourceRecord(raw: unknown, projectId: string): ProjectResourceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Partial<ProjectResourceRecord>;
  const id = normalizeOptionalString(record.id);
  const name = normalizeOptionalString(record.name);
  if (!id || !name) {
    return null;
  }
  const text = normalizeOptionalString(record.text);
  const status =
    record.status === "unsupported" || record.status === "error" || record.status === "ready"
      ? record.status
      : text
        ? "ready"
        : "error";
  return {
    id,
    projectId,
    name,
    kind: record.kind === "file" ? "file" : "note",
    sourceType:
      record.sourceType === "local_file"
        ? "local_file"
        : record.sourceType === "uploaded_file"
          ? "uploaded_file"
          : "manual",
    sourcePath: normalizeOptionalString(record.sourcePath),
    extension: normalizeOptionalString(record.extension),
    mediaType: normalizeOptionalString(record.mediaType),
    sizeBytes: normalizeNonNegativeNumber(record.sizeBytes),
    sha256: normalizeOptionalString(record.sha256) ?? hashString(text ?? ""),
    status,
    error: normalizeOptionalString(record.error),
    text,
    textPreview: makeTextPreview(record.textPreview ?? text ?? ""),
    tokenEstimate: normalizeNonNegativeNumber(record.tokenEstimate) ?? estimateTokens(text ?? ""),
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
    indexedAt: normalizeNonNegativeNumber(record.indexedAt),
  };
}

function findProjectRecord(
  store: ProjectsStore,
  projectId: string,
  opts?: { includeArchived?: boolean },
): ProjectRecord {
  const id = normalizeProjectId(projectId);
  const project = store.projects.find(
    (entry) => entry.id === id && (opts?.includeArchived === true || entry.archived !== true),
  );
  if (!project) {
    throw new ProjectsStoreError(`project not found: ${projectId}`, "not_found");
  }
  return project;
}

function normalizeProjectId(raw: unknown): string {
  return (
    normalizeOptionalString(raw)
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-") ?? ""
  );
}

function buildProjectId(name: string, existingIds: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  const taken = new Set(existingIds);
  let candidate = base;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function normalizeRequiredText(value: unknown, field: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new ProjectsStoreError(`${field} is required`, "invalid");
  }
  return normalized;
}

function assignOptionalText<T extends Record<string, unknown>>(
  target: T,
  key: keyof T,
  value: string | null | undefined,
) {
  if (value === null) {
    delete target[key];
    return;
  }
  if (value !== undefined) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      target[key] = normalized as T[keyof T];
    } else {
      delete target[key];
    }
  }
}

async function extractResourceText(params: {
  projectId: string;
  name?: string;
  path?: string;
  content?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  name: string;
  sourceType: "local_file" | "uploaded_file" | "manual";
  sourcePath?: string;
  extension?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256: string;
  status: ProjectResourceStatus;
  error?: string;
  text?: string;
}> {
  const manualContent = normalizeOptionalString(params.content);
  const rawPath = normalizeOptionalString(params.path);
  if (manualContent !== undefined && !rawPath) {
    const name = normalizeOptionalString(params.name) ?? "Project note";
    const text = truncateUtf16Safe(manualContent, MAX_RESOURCE_TEXT_CHARS);
    return {
      name,
      sourceType: "manual",
      sha256: hashString(manualContent),
      status: "ready",
      text,
      sizeBytes: Buffer.byteLength(manualContent),
      mediaType: "text/plain",
    };
  }
  if (!rawPath) {
    throw new ProjectsStoreError("path or content is required", "invalid");
  }
  const resolvedPath = resolveUserPath(rawPath, params.env);
  const stat = await fs.stat(resolvedPath).catch((err) => {
    throw new ProjectsStoreError(`failed to read resource: ${formatError(err)}`, "unavailable");
  });
  if (!stat.isFile()) {
    throw new ProjectsStoreError("resource path must be a file", "invalid");
  }
  if (stat.size > MAX_RESOURCE_BYTES) {
    return {
      name: normalizeOptionalString(params.name) ?? path.basename(resolvedPath),
      sourceType: "local_file",
      sourcePath: resolvedPath,
      extension: path.extname(resolvedPath).toLowerCase(),
      mediaType: "application/octet-stream",
      sizeBytes: stat.size,
      sha256: hashString(resolvedPath),
      status: "error",
      error: `file is too large for Projects V1 (${formatBytes(stat.size)} > ${formatBytes(MAX_RESOURCE_BYTES)})`,
    };
  }
  const buffer = await fs.readFile(resolvedPath);
  return extractFileLikeResourceText({
    buffer,
    name: normalizeOptionalString(params.name) ?? path.basename(resolvedPath),
    sourceType: "local_file",
    sourcePath: resolvedPath,
    extension: path.extname(resolvedPath).toLowerCase(),
  });
}

async function extractUploadedResourceText(params: {
  name?: string;
  fileName: string;
  mediaType?: string;
  contentBase64: string;
}): Promise<{
  name: string;
  sourceType: "uploaded_file";
  extension?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256: string;
  status: ProjectResourceStatus;
  error?: string;
  text?: string;
}> {
  const fileName = normalizeRequiredText(params.fileName, "fileName");
  const contentBase64 = normalizeRequiredText(params.contentBase64, "contentBase64").replace(
    /\s+/g,
    "",
  );
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 === 1) {
    throw new ProjectsStoreError("contentBase64 is not valid base64", "invalid");
  }
  const buffer = Buffer.from(contentBase64, "base64");
  const extracted = await extractFileLikeResourceText({
    buffer,
    name: normalizeOptionalString(params.name) ?? fileName,
    sourceType: "uploaded_file",
    extension: path.extname(fileName).toLowerCase(),
    mediaType: normalizeOptionalString(params.mediaType),
  });
  return { ...extracted, sourceType: "uploaded_file" };
}

async function extractFileLikeResourceText(params: {
  buffer: Buffer;
  name: string;
  sourceType: "local_file" | "uploaded_file";
  sourcePath?: string;
  extension: string;
  mediaType?: string;
}): Promise<{
  name: string;
  sourceType: "local_file" | "uploaded_file";
  sourcePath?: string;
  extension?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256: string;
  status: ProjectResourceStatus;
  error?: string;
  text?: string;
}> {
  const { buffer, extension, name, sourcePath, sourceType } = params;
  if (buffer.byteLength > MAX_RESOURCE_BYTES) {
    return {
      name,
      sourceType,
      sourcePath,
      extension,
      mediaType: params.mediaType ?? "application/octet-stream",
      sizeBytes: buffer.byteLength,
      sha256: hashBuffer(buffer),
      status: "error",
      error: `file is too large for Projects V1 (${formatBytes(buffer.byteLength)} > ${formatBytes(MAX_RESOURCE_BYTES)})`,
    };
  }
  const sha256 = hashBuffer(buffer);
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = truncateUtf16Safe(buffer.toString("utf8"), MAX_RESOURCE_TEXT_CHARS);
    return {
      name,
      sourceType,
      sourcePath,
      extension,
      mediaType: params.mediaType ?? mediaTypeForExtension(extension),
      sizeBytes: buffer.byteLength,
      sha256,
      status: "ready",
      text,
    };
  }
  if (extension === ".docx") {
    const text = await extractDocxText(buffer);
    return {
      name,
      sourceType,
      sourcePath,
      extension,
      mediaType:
        params.mediaType ??
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: buffer.byteLength,
      sha256,
      status: text ? "ready" : "error",
      text: text ? truncateUtf16Safe(text, MAX_RESOURCE_TEXT_CHARS) : undefined,
      error: text ? undefined : "DOCX file did not contain readable document text",
    };
  }
  return {
    name,
    sourceType,
    sourcePath,
    extension,
    mediaType: params.mediaType ?? mediaTypeForExtension(extension),
    sizeBytes: buffer.byteLength,
    sha256,
    status: "unsupported",
    error: `unsupported resource type: ${extension || "unknown"}`,
  };
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml) {
      return "";
    }
    return decodeXmlText(
      documentXml
        .replace(/<w:tab\s*\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    );
  } catch {
    return "";
  }
}

function decodeXmlText(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function scoreResource(resource: ProjectResourceRecord, query?: string): number {
  const normalizedQuery = normalizeOptionalString(query)?.toLowerCase();
  if (!normalizedQuery) {
    return resource.updatedAt;
  }
  const haystack =
    `${resource.name}\n${resource.textPreview ?? ""}\n${resource.text ?? ""}`.toLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 10_000 : 0), resource.updatedAt);
}

function takeWithinBudget(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  return truncateUtf16Safe(text, budget);
}

function makeTextPreview(text: string): string | undefined {
  const normalized = normalizeOptionalString(text.replace(/\s+/g, " "));
  return normalized ? truncateUtf16Safe(normalized, 500) : undefined;
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashBuffer(input: Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function mediaTypeForExtension(extension: string): string {
  switch (extension) {
    case ".csv":
      return "text/csv";
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".text":
      return "text/plain";
    default:
      return TEXT_EXTENSIONS.has(extension) ? "text/plain" : "application/octet-stream";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
