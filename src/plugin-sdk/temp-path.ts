import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sanitizePrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
  const token = suffix.replace(/^[._-]+/, "");
  if (!token) {
    return "";
  }
  return `.${token}`;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(params.tmpDir ?? os.tmpdir(), `${prefix}-${now}-${uuid}${extension}`);
}

export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const tempRoot = params.tmpDir ?? os.tmpdir();
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(tempRoot, prefix));
  const tmpPath = path.join(dir, sanitizeFileName(params.fileName ?? "download.bin"));
  try {
    return await fn(tmpPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
