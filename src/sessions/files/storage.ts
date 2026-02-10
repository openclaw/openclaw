import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionFileType, SessionFileMetadata } from "./types.js";
import { parseCsv } from "./csv-parser.js";
import { loadIndex, addFileToIndex, removeFileFromIndex } from "./index.js";
import { convertToMarkdown } from "./markdown-converter.js";
import { resolveSessionFilesDir } from "./paths.js";

export async function saveFile(params: {
  sessionId: string;
  agentId?: string;
  filename: string;
  type: SessionFileType;
  buffer: Buffer;
  filesDir?: string; // For testing
}): Promise<string> {
  const { sessionId, agentId, filename, type, buffer, filesDir } = params;
  const baseDir = filesDir ?? resolveSessionFilesDir(sessionId, agentId);
  const indexPath = path.join(baseDir, "index.json");

  const fileId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const fileBase = `${fileId}-${filename}`;
  const mdPath = path.join(baseDir, `${fileBase}.md`);

  await fs.mkdir(baseDir, { recursive: true });

  // Convert to markdown and save
  const markdown = await convertToMarkdown(buffer, type, filename);
  await fs.writeFile(mdPath, markdown, "utf-8");

  const metadata: SessionFileMetadata = {
    id: fileId,
    filename,
    type,
    uploadedAt: Date.now(),
    size: buffer.byteLength,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };

  // Parse CSV if needed
  if (type === "csv") {
    const csvText = buffer.toString("utf-8");
    const parsed = parseCsv(csvText);
    const parsedPath = path.join(baseDir, `${fileBase}.parsed.json`);
    await fs.writeFile(parsedPath, JSON.stringify(parsed, null, 2));
    metadata.csvSchema = {
      columns: parsed.columns,
      rowCount: parsed.rows.length,
    };
  }

  await addFileToIndex(indexPath, metadata);
  return fileId;
}

export async function getFile(params: {
  sessionId: string;
  agentId?: string;
  fileId: string;
  filesDir?: string;
}): Promise<{ buffer: Buffer; metadata: SessionFileMetadata }> {
  const { sessionId, agentId, fileId, filesDir } = params;
  const baseDir = filesDir ?? resolveSessionFilesDir(sessionId, agentId);
  const indexPath = path.join(baseDir, "index.json");
  const index = await loadIndex(indexPath);
  const file = index.files.find((f) => f.id === fileId);
  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  const fileBase = `${fileId}-${file.filename}`;
  const mdPath = path.join(baseDir, `${fileBase}.md`);
  const rawPath = path.join(baseDir, `${fileBase}.raw`);

  // Try .md first, fallback to .raw for backward compatibility
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(mdPath);
  } catch {
    // Fallback to .raw for backward compatibility
    buffer = await fs.readFile(rawPath);
  }

  return { buffer, metadata: file };
}

export async function listFiles(params: {
  sessionId: string;
  agentId?: string;
  filesDir?: string;
}): Promise<SessionFileMetadata[]> {
  const { sessionId, agentId, filesDir } = params;
  const baseDir = filesDir ?? resolveSessionFilesDir(sessionId, agentId);
  const indexPath = path.join(baseDir, "index.json");
  const index = await loadIndex(indexPath);
  return index.files;
}

export async function getParsedCsv(params: {
  sessionId: string;
  agentId?: string;
  fileId: string;
  filesDir?: string;
}): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const { sessionId, agentId, fileId, filesDir } = params;
  const baseDir = filesDir ?? resolveSessionFilesDir(sessionId, agentId);
  const indexPath = path.join(baseDir, "index.json");
  const index = await loadIndex(indexPath);
  const file = index.files.find((f) => f.id === fileId);
  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }
  if (file.type !== "csv") {
    throw new Error(`File ${fileId} is not a CSV file`);
  }
  const fileBase = `${fileId}-${file.filename}`;
  const parsedPath = path.join(baseDir, `${fileBase}.parsed.json`);
  const content = await fs.readFile(parsedPath, "utf-8");
  return JSON.parse(content) as { columns: string[]; rows: Record<string, unknown>[] };
}

export async function deleteFile(params: {
  sessionId: string;
  agentId?: string;
  fileId: string;
  filesDir?: string;
}): Promise<void> {
  const { sessionId, agentId, fileId, filesDir } = params;
  const baseDir = filesDir ?? resolveSessionFilesDir(sessionId, agentId);
  const indexPath = path.join(baseDir, "index.json");
  const index = await loadIndex(indexPath);
  const file = index.files.find((f) => f.id === fileId);
  if (!file) {
    return; // Already deleted
  }
  const fileBase = `${fileId}-${file.filename}`;
  const rawPath = path.join(baseDir, `${fileBase}.raw`);
  await fs.unlink(rawPath).catch(() => {});
  if (file.type === "csv") {
    const parsedPath = path.join(baseDir, `${fileBase}.parsed.json`);
    await fs.unlink(parsedPath).catch(() => {});
  }
  await removeFileFromIndex(indexPath, fileId);
}
