// Helpers for turning pasted paths and local folders into project document references.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreateProjectDocumentInput } from "./project-store.js";
import type { ProjectDocumentRecord } from "./project-types.js";

const DEFAULT_MAX_DEPTH = 4;
const MAX_IMPORT_CANDIDATES = 500;
const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".rtf",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
]);

export type ProjectDocumentImportInput = {
  projectId: string;
  text?: string | null;
  roots?: string[] | null;
  recursive?: boolean;
  maxDepth?: number;
  includeInContext?: boolean;
  kind?: string | null;
  notes?: string | null;
  existingDocuments?: ProjectDocumentRecord[];
};

export type ProjectDocumentImportCandidate = Omit<
  CreateProjectDocumentInput,
  "projectId" | "sortOrder"
>;

export type ProjectDocumentImportPlan = {
  candidates: ProjectDocumentImportCandidate[];
  skippedCount: number;
  scannedCount: number;
};

export function planProjectDocumentImport(
  input: ProjectDocumentImportInput,
): ProjectDocumentImportPlan {
  const defaults = {
    includeInContext: input.includeInContext !== false,
    kind: normalizeOptionalString(input.kind),
    notes: normalizeOptionalString(input.notes),
  };
  const candidates = [
    ...parseDocumentImportText(input.text, defaults),
    ...scanDocumentImportRoots({
      roots: input.roots ?? [],
      recursive: input.recursive !== false,
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      defaults,
    }),
  ];
  const existingKeys = new Set(
    (input.existingDocuments ?? []).flatMap((document) => documentKeys(document)),
  );
  const seenKeys = new Set<string>();
  const unique: ProjectDocumentImportCandidate[] = [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    const keys = documentKeys(candidate);
    if (keys.some((key) => existingKeys.has(key) || seenKeys.has(key))) {
      skippedCount += 1;
      continue;
    }
    keys.forEach((key) => seenKeys.add(key));
    unique.push(candidate);
    if (unique.length >= MAX_IMPORT_CANDIDATES) {
      skippedCount += candidates.length - skippedCount - unique.length;
      break;
    }
  }

  return {
    candidates: unique,
    skippedCount,
    scannedCount: candidates.length,
  };
}

function parseDocumentImportText(
  text: string | null | undefined,
  defaults: Pick<ProjectDocumentImportCandidate, "includeInContext" | "kind" | "notes">,
): ProjectDocumentImportCandidate[] {
  return (text ?? "")
    .split(/\r?\n/u)
    .map(parseDocumentImportLine)
    .filter((candidate): candidate is ProjectDocumentImportCandidate => Boolean(candidate))
    .map((candidate) => ({ ...defaults, ...candidate }));
}

function parseDocumentImportLine(line: string): ProjectDocumentImportCandidate | null {
  const value = line
    .trim()
    .replace(/^[-*]\s+/u, "")
    .replace(/^\d+[.)]\s+/u, "")
    .trim();
  if (!value) {
    return null;
  }

  const markdownLink = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(value);
  if (markdownLink) {
    return {
      title: markdownLink[1]?.trim() ?? "",
      uri: markdownLink[2]?.trim(),
      kind: inferDocumentKind(markdownLink[2]),
    };
  }

  const wikiLink = /^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/u.exec(value);
  if (wikiLink) {
    const uri = wikiLink[1]?.trim() ?? "";
    return {
      title: wikiLink[2]?.trim() || titleFromPath(uri),
      uri,
      kind: "obsidian",
    };
  }

  const parts = value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return {
      title: parts[0] ?? titleFromPath(parts[1] ?? value),
      uri: parts[1],
      kind: parts[2] || inferDocumentKind(parts[1]),
      notes: parts.slice(3).join(" | ") || undefined,
    };
  }

  return {
    title: titleFromPath(value),
    uri: value,
    kind: inferDocumentKind(value),
  };
}

function scanDocumentImportRoots(params: {
  roots: string[];
  recursive: boolean;
  maxDepth: number;
  defaults: Pick<ProjectDocumentImportCandidate, "includeInContext" | "kind" | "notes">;
}): ProjectDocumentImportCandidate[] {
  const maxDepth = Math.max(0, Math.min(8, Math.floor(params.maxDepth)));
  const candidates: ProjectDocumentImportCandidate[] = [];
  for (const root of params.roots) {
    const expandedRoot = expandHome(root.trim());
    if (!expandedRoot) {
      continue;
    }
    collectDocumentFiles({
      currentPath: path.resolve(expandedRoot),
      depth: 0,
      maxDepth,
      recursive: params.recursive,
      candidates,
      defaults: params.defaults,
    });
    if (candidates.length >= MAX_IMPORT_CANDIDATES) {
      break;
    }
  }
  return candidates.slice(0, MAX_IMPORT_CANDIDATES);
}

function collectDocumentFiles(params: {
  currentPath: string;
  depth: number;
  maxDepth: number;
  recursive: boolean;
  candidates: ProjectDocumentImportCandidate[];
  defaults: Pick<ProjectDocumentImportCandidate, "includeInContext" | "kind" | "notes">;
}): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(params.currentPath);
  } catch {
    return;
  }

  if (stat.isFile()) {
    appendDocumentFile(params.candidates, params.currentPath, params.defaults);
    return;
  }
  if (!stat.isDirectory() || params.depth > params.maxDepth) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(params.currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(params.currentPath, entry.name);
    if (entry.isDirectory()) {
      if (params.recursive) {
        collectDocumentFiles({ ...params, currentPath: entryPath, depth: params.depth + 1 });
      }
      continue;
    }
    if (entry.isFile()) {
      appendDocumentFile(params.candidates, entryPath, params.defaults);
    }
    if (params.candidates.length >= MAX_IMPORT_CANDIDATES) {
      return;
    }
  }
}

function appendDocumentFile(
  candidates: ProjectDocumentImportCandidate[],
  filePath: string,
  defaults: Pick<ProjectDocumentImportCandidate, "includeInContext" | "kind" | "notes">,
): void {
  if (!DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return;
  }
  candidates.push({
    ...defaults,
    title: titleFromPath(filePath),
    uri: filePath,
    kind: defaults.kind ?? inferDocumentKind(filePath),
  });
}

function documentKeys(document: { title?: string; uri?: string | null }): string[] {
  const keys: string[] = [];
  const uri = normalizeOptionalString(document.uri);
  const title = normalizeOptionalString(document.title);
  if (uri) {
    keys.push(`uri:${uri.toLowerCase()}`);
  }
  if (title) {
    keys.push(`title:${title.toLowerCase()}`);
  }
  return keys;
}

function titleFromPath(value: string): string {
  const normalized = value.trim().replace(/^obsidian:\/\//u, "");
  const withoutHash = normalized.split("#")[0] ?? normalized;
  const basename = path.basename(withoutHash) || withoutHash;
  const extension = path.extname(basename);
  return (extension ? basename.slice(0, -extension.length) : basename).trim() || value.trim();
}

function inferDocumentKind(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return "url";
  }
  if (normalized.startsWith("obsidian://") || normalized.includes("/obsidian/")) {
    return "obsidian";
  }
  const extension = path.extname(normalized).replace(/^\./u, "");
  return extension || "file";
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
