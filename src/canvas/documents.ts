import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../packages/gateway-protocol/src/schema/canvas.js";
import { resolveStateDir } from "../config/paths.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { CANVAS_DOCUMENTS_PATH } from "./constants.js";

const CANVAS_DOCUMENT_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;

type CanvasDocumentKind = "html_bundle" | "url_embed" | "document" | "image" | "video_asset";

type CanvasDocumentCreateInput = {
  html: string;
  title?: string;
  retentionScope?: string;
  /** Serve with a CSP sandbox header so direct opens get an opaque origin. */
  cspSandbox?: "scripts";
};

export type CanvasDocumentManifest = {
  id: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  createdAt: string;
  entryUrl: string;
  localEntrypoint?: string;
  externalUrl?: string;
  surface?: "assistant_message" | "tool_card" | "sidebar";
  retentionScope?: string;
  cspSandbox?: "scripts";
  assets: Array<{
    logicalPath: string;
    contentType?: string;
  }>;
};

function normalizeLogicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part === "." || part === ".." || part.includes(":") || containsAsciiControlCharacter(part),
    )
  ) {
    throw new Error("canvas document logicalPath invalid");
  }
  return parts.join("/");
}

function normalizeCanvasDocumentId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    throw new Error("canvas document id invalid");
  }
  return normalized;
}

/** Stable root for existing and newly created Canvas documents. */
export function resolveCanvasDocumentsDir(stateDir = resolveStateDir()): string {
  return path.resolve(stateDir, "canvas", "documents");
}

export async function readCanvasDocumentHtmlSource(
  documentId: string,
): Promise<{ html: string; cspSandbox?: "scripts" }> {
  const id = normalizeCanvasDocumentId(documentId);
  // Keep the document directory inside the guarded root so aliases cannot select another document.
  const root = await fsRoot(resolveCanvasDocumentsDir(), {
    maxBytes: CANVAS_DOCUMENT_MANIFEST_MAX_BYTES,
  });
  const manifest = await root.readJson<Partial<CanvasDocumentManifest>>(`${id}/manifest.json`);
  if (manifest.id !== id || typeof manifest.localEntrypoint !== "string") {
    throw new Error(`canvas document has no local entrypoint: ${id}`);
  }
  const entrypoint = normalizeLogicalPath(manifest.localEntrypoint);
  if (!entrypoint.toLowerCase().endsWith(".html")) {
    throw new Error(`canvas document entrypoint is not HTML: ${id}`);
  }
  return {
    html: await root.readText(`${id}/${entrypoint}`, {
      maxBytes: WIDGET_HTML_MAX_UTF8_BYTES,
    }),
    ...(manifest.cspSandbox === "scripts" ? { cspSandbox: "scripts" as const } : {}),
  };
}

async function pruneCanvasDocumentsForScope(params: {
  documentsDir: string;
  retentionScope: string;
}): Promise<void> {
  const entries = await fs.readdir(params.documentsDir, { withFileTypes: true });
  const scopedDocuments = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(params.documentsDir, entry.name, "manifest.json"),
                "utf8",
              ),
            ) as { createdAt?: unknown; retentionScope?: unknown };
            if (
              manifest.retentionScope !== params.retentionScope ||
              typeof manifest.createdAt !== "string"
            ) {
              return null;
            }
            return { id: entry.name, createdAt: manifest.createdAt };
          } catch {
            return null;
          }
        }),
    )
  ).filter((entry): entry is { id: string; createdAt: string } => entry !== null);
  const deleteCount = Math.max(0, scopedDocuments.length - WIDGET_MAX_PER_SCOPE);
  const oldest = scopedDocuments
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(0, deleteCount);
  await Promise.all(
    oldest.map((entry) =>
      fs.rm(path.join(params.documentsDir, entry.id), { recursive: true, force: true }),
    ),
  );
}

export function parseCanvasDocumentHttpPath(
  requestPath: string,
): { documentId: string; entrypoint: string } | null {
  const trimmed = requestPath.trim();
  const prefix = `${CANVAS_DOCUMENTS_PATH}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const pathWithoutQuery = trimmed.replace(/[?#].*$/, "");
  const relative = pathWithoutQuery.slice(prefix.length);
  try {
    const [rawDocumentId, ...entrySegments] = relative
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (!rawDocumentId || entrySegments.length === 0) {
      return null;
    }
    const documentId = normalizeCanvasDocumentId(rawDocumentId);
    return { documentId, entrypoint: normalizeLogicalPath(entrySegments.join("/")) };
  } catch {
    return null;
  }
}

export function resolveCanvasHttpPathToLocalPath(requestPath: string): string | null {
  const parsed = parseCanvasDocumentHttpPath(requestPath);
  if (!parsed) {
    return null;
  }
  const documentsDir = resolveCanvasDocumentsDir();
  const candidatePath = path.resolve(documentsDir, parsed.documentId, parsed.entrypoint);
  return candidatePath.startsWith(`${documentsDir}${path.sep}`) ? candidatePath : null;
}

export async function createCanvasDocument(
  input: CanvasDocumentCreateInput,
): Promise<CanvasDocumentManifest> {
  const id = `cv_${randomUUID().replaceAll("-", "")}`;
  const rootDir = path.join(resolveCanvasDocumentsDir(), id);
  await fs.mkdir(rootDir, { recursive: true });
  const root = await fsRoot(rootDir);
  await root.write("index.html", input.html);
  const manifest: CanvasDocumentManifest = {
    id,
    kind: "html_bundle",
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    surface: "assistant_message",
    ...(input.retentionScope ? { retentionScope: input.retentionScope } : {}),
    ...(input.cspSandbox ? { cspSandbox: input.cspSandbox } : {}),
    createdAt: new Date().toISOString(),
    entryUrl: `${CANVAS_DOCUMENTS_PATH}/${encodeURIComponent(id)}/index.html`,
    localEntrypoint: "index.html",
    assets: [],
  };
  await root.writeJson("manifest.json", manifest, { space: 2 });
  if (input.retentionScope) {
    // Bounded transcript widgets cannot grow managed Canvas storage without limit.
    await pruneCanvasDocumentsForScope({
      documentsDir: resolveCanvasDocumentsDir(),
      retentionScope: input.retentionScope,
    });
  }
  return manifest;
}
